import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAsyncStorageGetItem,
  mockAsyncStorageRemoveItem,
  mockAsyncStorageSetItem,
  mockStoreSubscribe,
  mockStoreState,
  mockAlarmDeleteAlarm,
  mockAlarmDeleteRepeatingAlarm,
  mockAlarmRemoveAllFiredNotifications,
  mockAlarmRemoveFiredNotification,
  mockAlarmRequestPermissions,
  mockAlarmSendNotification,
  mockAlarmScheduleAlarm,
  mockAlarmGetScheduledAlarms,
  mockEnsureReminderNotificationChannel,
  mockRestorePersistentCaptureNotification,
  mockIsLoggingEnabled,
  mockLogInfo,
  mockPlatform,
  mockPermissionsAndroidCheck,
  mockPermissionsAndroidRequest,
} = vi.hoisted(() => ({
  mockAsyncStorageGetItem: vi.fn(),
  mockAsyncStorageRemoveItem: vi.fn(),
  mockAsyncStorageSetItem: vi.fn(),
  mockStoreSubscribe: vi.fn(() => () => undefined),
  mockStoreState: {
    settings: {} as Record<string, unknown>,
    tasks: [] as Array<{
      id: string;
      title: string;
      status?: string;
      description?: string;
      dueDate?: string;
      reviewAt?: string;
      startTime?: string;
      repeatReminderMinutes?: number;
      suppressMindwtrReminders?: boolean;
    }>,
    projects: [] as Array<Record<string, unknown>>,
  },
  mockAlarmDeleteAlarm: vi.fn(),
  mockAlarmDeleteRepeatingAlarm: vi.fn(),
  mockAlarmRemoveAllFiredNotifications: vi.fn(),
  mockAlarmRemoveFiredNotification: vi.fn(),
  mockAlarmRequestPermissions: vi.fn(async () => ({ alert: true })),
  mockAlarmSendNotification: vi.fn(),
  mockAlarmScheduleAlarm: vi.fn(async () => ({ id: 99 })),
  mockAlarmGetScheduledAlarms: vi.fn(async () => [] as Array<{ id: string }>),
  mockEnsureReminderNotificationChannel: vi.fn(async () => undefined),
  mockRestorePersistentCaptureNotification: vi.fn(),
  mockIsLoggingEnabled: vi.fn(() => true),
  mockLogInfo: vi.fn(async () => undefined),
  mockPlatform: {
    OS: 'android',
    Version: 34,
  },
  mockPermissionsAndroidCheck: vi.fn(async () => true),
  mockPermissionsAndroidRequest: vi.fn(async () => 'granted'),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: mockAsyncStorageGetItem,
    removeItem: mockAsyncStorageRemoveItem,
    setItem: mockAsyncStorageSetItem,
  },
}));

vi.mock('react-native', () => ({
  NativeEventEmitter: class {
    addListener() {
      return { remove: () => undefined };
    }
  },
  NativeModules: {},
  PermissionsAndroid: {
    PERMISSIONS: { POST_NOTIFICATIONS: 'POST_NOTIFICATIONS' },
    RESULTS: { GRANTED: 'granted', NEVER_ASK_AGAIN: 'never_ask_again' },
    check: mockPermissionsAndroidCheck,
    request: mockPermissionsAndroidRequest,
  },
  Platform: mockPlatform,
}));

vi.mock('react-native-alarm-notification', () => ({
  default: {
    parseDate: (date: Date) => date.toISOString(),
    scheduleAlarm: mockAlarmScheduleAlarm,
    sendNotification: mockAlarmSendNotification,
    deleteAlarm: mockAlarmDeleteAlarm,
    deleteRepeatingAlarm: mockAlarmDeleteRepeatingAlarm,
    removeFiredNotification: mockAlarmRemoveFiredNotification,
    removeAllFiredNotifications: mockAlarmRemoveAllFiredNotifications,
    getScheduledAlarms: mockAlarmGetScheduledAlarms,
    requestPermissions: mockAlarmRequestPermissions,
  },
}));

// Only the genuinely platform-specific bits are replaced: language/translation loading (which
// otherwise pulls in the real i18n loader) and the store. `buildReminderSchedule`,
// `getTaskReminderPlan`, `hasTimeComponent`, `safeParseDate`, etc. are the REAL core
// implementations, so a change to core's reminder-kind selection or gating shows up here instead
// of being invisible behind a hand-rolled stub.
vi.mock('@mindwtr/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mindwtr/core')>();
  return {
    ...actual,
    getSystemDefaultLanguage: vi.fn(() => 'en'),
    getTranslations: vi.fn(async () => ({
      'digest.morningTitle': 'Morning',
      'digest.morningBody': 'Morning body',
      'digest.eveningTitle': 'Evening',
      'digest.eveningBody': 'Evening body',
      'digest.weeklyReviewTitle': 'Weekly review',
      'digest.weeklyReviewBody': 'Weekly review body',
      'review.projectsStep': 'Review project',
    })),
    loadStoredLanguage: vi.fn(async () => 'en'),
    useTaskStore: {
      getState: () => mockStoreState,
      subscribe: mockStoreSubscribe,
    },
  };
});

vi.mock('./app-log', () => ({
  isLoggingEnabled: mockIsLoggingEnabled,
  logInfo: mockLogInfo,
  logWarn: vi.fn(async () => undefined),
}));

vi.mock('@/modules/notification-open-intents', () => ({
  ensureReminderNotificationChannel: mockEnsureReminderNotificationChannel,
  restorePersistentCaptureNotification: mockRestorePersistentCaptureNotification,
}));

import {
  __localNotificationTestUtils,
  cancelLocalPomodoroCompletionNotification,
  scheduleLocalPomodoroCompletionNotification,
  sendLocalMobileNotification,
  setLocalNotificationOpenHandler,
  startLocalMobileNotifications,
  stopLocalMobileNotifications,
} from './notification-service-local';

describe('notification-service-local', () => {
  beforeEach(() => {
    mockAsyncStorageGetItem.mockReset();
    mockAsyncStorageRemoveItem.mockReset();
    mockAsyncStorageSetItem.mockReset();
    mockStoreSubscribe.mockClear();
    mockStoreState.settings = {};
    mockStoreState.tasks = [];
    mockStoreState.projects = [];
    mockAlarmDeleteAlarm.mockReset();
    mockAlarmDeleteRepeatingAlarm.mockReset();
    mockAlarmRemoveAllFiredNotifications.mockReset();
    mockAlarmRemoveFiredNotification.mockReset();
    mockAlarmRequestPermissions.mockReset();
    mockAlarmRequestPermissions.mockResolvedValue({ alert: true });
    mockAlarmSendNotification.mockReset();
    mockAlarmScheduleAlarm.mockReset();
    mockAlarmScheduleAlarm.mockResolvedValue({ id: 99 });
    mockAlarmGetScheduledAlarms.mockReset();
    mockAlarmGetScheduledAlarms.mockResolvedValue([]);
    mockEnsureReminderNotificationChannel.mockReset();
    mockEnsureReminderNotificationChannel.mockResolvedValue(undefined);
    mockRestorePersistentCaptureNotification.mockReset();
    mockLogInfo.mockClear();
    mockIsLoggingEnabled.mockReset();
    mockIsLoggingEnabled.mockReturnValue(true);
    mockPermissionsAndroidCheck.mockReset();
    mockPermissionsAndroidRequest.mockReset();
    mockPermissionsAndroidCheck.mockResolvedValue(true);
    mockPermissionsAndroidRequest.mockResolvedValue('granted');
    mockPlatform.OS = 'android';
    mockPlatform.Version = 34;
    __localNotificationTestUtils.resetForTests();
  });

  afterEach(() => {
    __localNotificationTestUtils.resetForTests();
  });

  it('retries loading the alarm map after a failed storage read', async () => {
    mockAsyncStorageGetItem
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValueOnce(JSON.stringify({ 'task:1': { id: 42 } }));

    await __localNotificationTestUtils.loadAlarmMapIfNeeded();
    expect(__localNotificationTestUtils.isAlarmMapLoaded()).toBe(false);
    expect(__localNotificationTestUtils.getAlarmMapSnapshot().size).toBe(0);

    await __localNotificationTestUtils.loadAlarmMapIfNeeded();
    expect(__localNotificationTestUtils.isAlarmMapLoaded()).toBe(true);
    expect(__localNotificationTestUtils.getAlarmMapSnapshot().get('task:1')).toEqual({ id: 42 });
  });

  it('clears the notification open handler when the service stops', async () => {
    const handler = vi.fn();
    setLocalNotificationOpenHandler(handler);

    expect(__localNotificationTestUtils.getNotificationOpenHandler()).toBe(handler);

    await stopLocalMobileNotifications();

    expect(__localNotificationTestUtils.getNotificationOpenHandler()).toBeNull();
  });

  it('clears persisted alarms when Android notification permission is denied on startup', async () => {
    mockAsyncStorageGetItem.mockResolvedValue(JSON.stringify({ 'task:1': { id: 42 } }));
    mockPermissionsAndroidCheck.mockResolvedValue(false);
    mockPermissionsAndroidRequest.mockResolvedValue('never_ask_again');

    await startLocalMobileNotifications();

    expect(mockAlarmDeleteAlarm).toHaveBeenCalledWith(42);
    expect(mockAlarmDeleteRepeatingAlarm).toHaveBeenCalledWith(42);
    expect(mockAlarmRemoveFiredNotification).toHaveBeenCalledWith(42);
    expect(mockAlarmRemoveAllFiredNotifications).toHaveBeenCalledTimes(1);
    expect(__localNotificationTestUtils.getAlarmMapSnapshot().size).toBe(0);
    expect(mockAsyncStorageSetItem).toHaveBeenCalledWith('mindwtr:local:alarms:v1', '{}');
  });

  it('re-asserts the persistent capture notification after wiping fired notifications', async () => {
    await stopLocalMobileNotifications();

    // removeAllFiredNotifications() is NotificationManager.cancelAll(), which
    // also removes the pinned quick-capture notification (#819).
    expect(mockAlarmRemoveAllFiredNotifications).toHaveBeenCalledTimes(1);
    expect(mockRestorePersistentCaptureNotification).toHaveBeenCalledTimes(1);
    const wipeOrder = mockAlarmRemoveAllFiredNotifications.mock.invocationCallOrder[0];
    const restoreOrder = mockRestorePersistentCaptureNotification.mock.invocationCallOrder[0];
    expect(restoreOrder).toBeGreaterThan(wipeOrder);
  });

  it('ensures the Android reminder notification channel when permission is already granted', async () => {
    await startLocalMobileNotifications();

    expect(mockEnsureReminderNotificationChannel).toHaveBeenCalledWith(
      'mindwtr_reminders_v2',
      'Mindwtr reminders'
    );
  });

  it('ensures the Android reminder notification channel after permission is granted from the runtime prompt', async () => {
    mockPermissionsAndroidCheck.mockResolvedValue(false);
    mockPermissionsAndroidRequest.mockResolvedValue('granted');

    await startLocalMobileNotifications();

    expect(mockEnsureReminderNotificationChannel).toHaveBeenCalledWith(
      'mindwtr_reminders_v2',
      'Mindwtr reminders'
    );
  });

  it('schedules task reminders with a labelled message body and snooze action', async () => {
    mockStoreState.tasks = [
      {
        id: 'task-1',
        title: 'Pay rent',
        description: '',
        dueDate: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    ];

    await startLocalMobileNotifications();

    expect(mockAlarmScheduleAlarm).toHaveBeenCalledWith(
      expect.objectContaining({
        auto_cancel: true,
        channel: 'mindwtr_reminders_v2',
        has_button: true,
        has_complete_action: true,
        loop_sound: false,
        // No description on the task: the body is the reminder-kind label alone (English
        // fallback, since this test's translation dict has no 'settings.dueDateNotifications'
        // key), never raw markdown or a bare repeat of the title (#reminder-schedule).
        message: 'Due date reminder',
        play_sound: true,
        snooze_interval: 10,
        title: 'Pay rent',
        use_big_text: true,
        vibrate: false,
        data: expect.objectContaining({
          kind: 'task-reminder',
          notificationActionComplete: 'true',
          taskId: 'task-1',
        }),
      })
    );
  });

  it('schedules future due-time repeat occurrences as :r{i} keyed one-shots', async () => {
    mockStoreState.tasks = [{
      id: 'task-1',
      title: 'Pay rent',
      description: '',
      dueDate: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
      repeatReminderMinutes: 30,
    }];

    await startLocalMobileNotifications();

    const alarmKeys = (mockAlarmScheduleAlarm.mock.calls as unknown as Array<[{ data?: { alarmKey?: string } }]>)
      .map((call) => call[0]?.data?.alarmKey);
    // 30min interval, 120min window -> 4 occurrences (r1..r4), not a 5th.
    expect(alarmKeys).toEqual(expect.arrayContaining([
      'task:task-1:r1',
      'task:task-1:r2',
      'task:task-1:r3',
      'task:task-1:r4',
    ]));
    expect(alarmKeys).not.toContain('task:task-1:r5');
  });

  it('reaps due-time repeat occurrences when the task is no longer active', async () => {
    mockAsyncStorageGetItem.mockResolvedValue(JSON.stringify({
      'task:task-1:r1': { id: 42 },
      'task:task-1:r2': { id: 43 },
    }));
    // Done tasks get neither a base reminder nor repeat occurrences (core's isInactiveTask gate).
    mockStoreState.tasks = [{
      id: 'task-1',
      title: 'Pay rent',
      description: '',
      status: 'done',
      dueDate: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      repeatReminderMinutes: 30,
    }];

    await startLocalMobileNotifications();

    expect(mockAlarmDeleteAlarm).toHaveBeenCalledWith(42);
    expect(mockAlarmDeleteAlarm).toHaveBeenCalledWith(43);
    const snapshot = __localNotificationTestUtils.getAlarmMapSnapshot();
    expect(snapshot.has('task:task-1:r1')).toBe(false);
    expect(snapshot.has('task:task-1:r2')).toBe(false);
  });

  it('skips reschedules for store updates that leave tasks, projects, and settings untouched', async () => {
    await startLocalMobileNotifications();
    const listener = (mockStoreSubscribe.mock.calls as unknown[][])[0]?.[0] as (state: unknown, prevState: unknown) => void;
    expect(typeof listener).toBe('function');

    vi.useFakeTimers();
    try {
      const shared = {
        tasks: mockStoreState.tasks,
        projects: mockStoreState.projects,
        settings: mockStoreState.settings,
      };
      mockLogInfo.mockClear();
      listener({ ...shared, isLoading: true }, { ...shared, isLoading: false });
      await vi.advanceTimersByTimeAsync(3000);
      expect(mockLogInfo).not.toHaveBeenCalledWith(
        '[Local Notifications] Reschedule cycle started',
        expect.anything()
      );

      listener({ ...shared, tasks: [...mockStoreState.tasks] }, shared);
      await vi.advanceTimersByTimeAsync(3000);
      expect(mockLogInfo).toHaveBeenCalledWith(
        '[Local Notifications] Reschedule cycle started',
        expect.anything()
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reschedule when a settings update only touches sync bookkeeping fields', async () => {
    await startLocalMobileNotifications();
    const listener = (mockStoreSubscribe.mock.calls as unknown[][])[0]?.[0] as (state: unknown, prevState: unknown) => void;
    expect(typeof listener).toBe('function');

    vi.useFakeTimers();
    try {
      mockLogInfo.mockClear();
      const shared = {
        tasks: mockStoreState.tasks,
        projects: mockStoreState.projects,
      };
      const prevSettings = { ...mockStoreState.settings, lastSyncAt: '2026-08-31T00:00:00.000Z', lastSyncStatus: 'success' };
      const nextSettings = { ...prevSettings, lastSyncAt: '2026-09-01T00:00:00.000Z', lastSyncStats: { pushed: 3 } };
      listener({ ...shared, settings: nextSettings }, { ...shared, settings: prevSettings });
      await vi.advanceTimersByTimeAsync(3000);
      expect(mockLogInfo).not.toHaveBeenCalledWith(
        '[Local Notifications] Reschedule cycle started',
        expect.anything()
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('reschedules when a settings update changes a reminder-relevant field', async () => {
    await startLocalMobileNotifications();
    const listener = (mockStoreSubscribe.mock.calls as unknown[][])[0]?.[0] as (state: unknown, prevState: unknown) => void;
    expect(typeof listener).toBe('function');

    vi.useFakeTimers();
    try {
      mockLogInfo.mockClear();
      const shared = {
        tasks: mockStoreState.tasks,
        projects: mockStoreState.projects,
      };
      const prevSettings = { ...mockStoreState.settings, notificationsEnabled: true };
      const nextSettings = { ...prevSettings, notificationsEnabled: false };
      listener({ ...shared, settings: nextSettings }, { ...shared, settings: prevSettings });
      await vi.advanceTimersByTimeAsync(3000);
      expect(mockLogInfo).toHaveBeenCalledWith(
        '[Local Notifications] Reschedule cycle started',
        expect.anything()
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('reschedules when a settings update changes only the language (correction #3)', async () => {
    await startLocalMobileNotifications();
    const listener = (mockStoreSubscribe.mock.calls as unknown[][])[0]?.[0] as (state: unknown, prevState: unknown) => void;
    expect(typeof listener).toBe('function');

    vi.useFakeTimers();
    try {
      mockLogInfo.mockClear();
      const shared = {
        tasks: mockStoreState.tasks,
        projects: mockStoreState.projects,
      };
      // buildReminderSchedule never reads `language` directly, but the
      // reschedule cycle localizes every alarm title/body from it, so a
      // language-only change must still re-arm.
      const prevSettings = { ...mockStoreState.settings, language: 'en' };
      const nextSettings = { ...prevSettings, language: 'de' };
      listener({ ...shared, settings: nextSettings }, { ...shared, settings: prevSettings });
      await vi.advanceTimersByTimeAsync(3000);
      expect(mockLogInfo).toHaveBeenCalledWith(
        '[Local Notifications] Reschedule cycle started',
        expect.anything()
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs reminder scheduling diagnostics without task title or description content', async () => {
    const fireAt = new Date(Date.now() + 5 * 60 * 1000);
    mockStoreState.tasks = [
      {
        id: 'task-1',
        title: 'Private task title',
        description: 'Private task details',
        dueDate: fireAt.toISOString(),
      },
    ];

    await startLocalMobileNotifications();

    expect(mockLogInfo).toHaveBeenCalledWith(
      '[Local Notifications] Reschedule cycle complete',
      expect.objectContaining({
        scope: 'notifications',
        extra: expect.objectContaining({
          futureDueDateReminderCount: 1,
          oneShotReminderCount: 1,
          scheduledOneShotReminderCount: 1,
          taskReminderCount: 1,
        }),
      })
    );

    const logPayload = JSON.stringify(mockLogInfo.mock.calls);
    expect(logPayload).not.toContain('Private task title');
    expect(logPayload).not.toContain('Private task details');
  });

  it('reports the pending native alarm count alongside the tracked count', async () => {
    // #1020: a cancel that silently removes nothing leaves the OS holding more
    // pending requests than the alarm map tracks. That gap is invisible in the
    // app, so the cycle log has to carry it.
    mockStoreState.tasks = [
      { id: 'task-1', title: 'Task one', dueDate: new Date(Date.now() + 5 * 60 * 1000).toISOString() },
    ];
    mockAlarmGetScheduledAlarms.mockResolvedValueOnce([{ id: '1' }, { id: '2' }, { id: '3' }]);

    await startLocalMobileNotifications();

    expect(mockLogInfo).toHaveBeenCalledWith(
      '[Local Notifications] Reschedule cycle complete',
      expect.objectContaining({
        extra: expect.objectContaining({
          scheduledAlarmCount: 1,
          pendingNativeAlarmCount: 3,
        }),
      })
    );
  });

  it('does not enumerate pending native alarms when diagnostics logging is off', async () => {
    // The enumeration is a native round-trip that only feeds the cycle log, and
    // a reschedule runs on every store change (#766).
    mockIsLoggingEnabled.mockReturnValue(false);
    mockStoreState.tasks = [
      { id: 'task-1', title: 'Task one', dueDate: new Date(Date.now() + 5 * 60 * 1000).toISOString() },
    ];

    await startLocalMobileNotifications();

    expect(mockAlarmGetScheduledAlarms).not.toHaveBeenCalled();
  });

  it('does not rewrite the alarm map when a reschedule cycle derives the same alarms', async () => {
    // Most saves touch no reminder-relevant field, so the cycle re-derives an
    // identical map; persisting it again is an AsyncStorage write per save (#766).
    mockStoreState.tasks = [
      { id: 'task-1', title: 'Task one', dueDate: new Date(Date.now() + 5 * 60 * 1000).toISOString() },
    ];

    await startLocalMobileNotifications();
    const listener = (mockStoreSubscribe.mock.calls as unknown[][])[0]?.[0] as (state: unknown, prevState: unknown) => void;
    const alarmMapWrites = () => mockAsyncStorageSetItem.mock.calls.filter(
      ([key]) => key === 'mindwtr:local:alarms:v1'
    ).length;
    expect(alarmMapWrites()).toBe(1);

    vi.useFakeTimers();
    try {
      const shared = {
        tasks: mockStoreState.tasks,
        projects: mockStoreState.projects,
        settings: mockStoreState.settings,
      };
      // A task-array identity change with the same reminder fields: the cycle
      // runs, derives the same alarm, and must not touch storage again.
      listener({ ...shared, tasks: [...mockStoreState.tasks] }, shared);
      await vi.advanceTimersByTimeAsync(3000);
    } finally {
      vi.useRealTimers();
    }

    expect(mockLogInfo).toHaveBeenCalledWith(
      '[Local Notifications] Reschedule cycle complete',
      expect.anything()
    );
    expect(alarmMapWrites()).toBe(1);
  });

  it('only schedules the next 60 upcoming task reminders on iOS', async () => {
    const baseTime = new Date('2026-03-04T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
    mockPlatform.OS = 'ios';

    try {
      mockStoreState.tasks = Array.from({ length: 65 }, (_, index) => ({
        id: `task-${index}`,
        title: `Task ${index}`,
        description: '',
        dueDate: new Date(baseTime.getTime() + (index + 1) * 60_000).toISOString(),
      })).reverse();

      await startLocalMobileNotifications();

      const alarmScheduleCalls = mockAlarmScheduleAlarm.mock.calls as unknown as Array<[
        { data?: { taskId?: string } },
      ]>;
      const scheduledTaskIds = new Set(
        alarmScheduleCalls
          .map(([details]) => details.data?.taskId)
          .filter((taskId): taskId is string => typeof taskId === 'string')
      );

      expect(scheduledTaskIds.size).toBe(60);
      expect(scheduledTaskIds.has('task-0')).toBe(true);
      expect(scheduledTaskIds.has('task-59')).toBe(true);
      expect(scheduledTaskIds.has('task-60')).toBe(false);
    } finally {
      mockPlatform.OS = 'android';
      vi.useRealTimers();
    }
  });

  it('allows a larger one-shot reminder window on Android', async () => {
    const baseTime = new Date('2026-03-04T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);

    try {
      mockStoreState.tasks = Array.from({ length: 205 }, (_, index) => ({
        id: `task-${index}`,
        title: `Task ${index}`,
        description: '',
        dueDate: new Date(baseTime.getTime() + (index + 1) * 60_000).toISOString(),
      })).reverse();

      await startLocalMobileNotifications();

      const alarmScheduleCalls = mockAlarmScheduleAlarm.mock.calls as unknown as Array<[
        { data?: { taskId?: string } },
      ]>;
      const scheduledTaskIds = new Set(
        alarmScheduleCalls
          .map(([details]) => details.data?.taskId)
          .filter((taskId): taskId is string => typeof taskId === 'string')
      );

      expect(scheduledTaskIds.size).toBe(200);
      expect(scheduledTaskIds.has('task-0')).toBe(true);
      expect(scheduledTaskIds.has('task-199')).toBe(true);
      expect(scheduledTaskIds.has('task-200')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors separate start and due reminder preferences when both dates are set', async () => {
    mockStoreState.settings = {
      notificationsEnabled: true,
      startDateNotificationsEnabled: false,
      dueDateNotificationsEnabled: true,
    };
    mockStoreState.tasks = [
      {
        id: 'task-1',
        title: 'Pay rent',
        description: '',
        // Start reminders are off, so the earlier start time must be ignored and the due
        // reminder (later, still in the future) must be the one that gets scheduled.
        startTime: new Date(Date.now() + 1 * 60 * 1000).toISOString(),
        dueDate: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      },
    ];

    await startLocalMobileNotifications();

    expect(mockAlarmScheduleAlarm).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'task-reminder', taskId: 'task-1' }),
      })
    );
  });

  it('marks task review date reminders so notification taps can open Review', async () => {
    const reviewAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    mockStoreState.settings = {
      notificationsEnabled: true,
      reviewAtNotificationsEnabled: true,
    };
    mockStoreState.tasks = [
      {
        id: 'task-1',
        title: 'Review proposal',
        description: '',
        reviewAt,
      },
    ];

    await startLocalMobileNotifications();

    expect(mockAlarmScheduleAlarm).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: 'task-review',
          taskId: 'task-1',
        }),
        has_complete_action: false,
      })
    );
  });

  it('schedules weekly review even when task reminders are disabled', async () => {
    mockStoreState.settings = {
      notificationsEnabled: false,
      weeklyReviewEnabled: true,
      weeklyReviewDay: 2,
      weeklyReviewTime: '18:30',
    };

    await startLocalMobileNotifications();

    expect(mockAlarmScheduleAlarm).toHaveBeenCalledWith(
      expect.objectContaining({
        auto_cancel: true,
        channel: 'mindwtr_reminders_v2',
        message: 'Weekly review body',
        title: 'Weekly review',
      })
    );
  });

  it('reschedules current task reminders when startup is requested while already running', async () => {
    mockStoreState.tasks = [
      { id: 'recurring-original', title: 'Daily standup', description: '', dueDate: new Date(Date.now() + 5 * 60 * 1000).toISOString() },
    ];

    await startLocalMobileNotifications();

    expect(mockAlarmScheduleAlarm).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ taskId: 'recurring-original' }),
      })
    );

    mockAlarmScheduleAlarm.mockClear();
    mockStoreState.tasks = [
      { id: 'recurring-follow-up', title: 'Daily standup', description: '', dueDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() },
    ];

    await startLocalMobileNotifications();

    expect(mockAlarmScheduleAlarm).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ taskId: 'recurring-follow-up' }),
      })
    );
  });

  it('does not reschedule unchanged persisted daily digest alarms on startup', async () => {
    const signature = JSON.stringify({
      title: 'Morning',
      message: 'Morning body',
      fireAt: 'daily:09:00',
      repeatInterval: 'daily',
      hasSnoozeAction: false,
      data: { kind: 'daily-digest' },
    });
    mockAsyncStorageGetItem.mockResolvedValue(JSON.stringify({
      'digest:morning': { id: 42, signature },
    }));
    mockStoreState.settings = {
      notificationsEnabled: true,
      dailyDigestMorningEnabled: true,
      dailyDigestMorningTime: '09:00',
    };

    await startLocalMobileNotifications();

    expect(mockAlarmScheduleAlarm).not.toHaveBeenCalled();
    expect(__localNotificationTestUtils.getAlarmMapSnapshot().get('digest:morning')).toEqual({
      id: 42,
      signature,
    });
  });

  it('falls back to the title when sending an immediate notification without a message', async () => {
    await sendLocalMobileNotification('Focus session done');

    expect(mockAlarmSendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Focus session done',
        message: 'Focus session done',
      })
    );
    expect(mockAlarmScheduleAlarm).not.toHaveBeenCalled();
  });

  it('schedules a sound-enabled pomodoro completion alarm', async () => {
    mockAsyncStorageGetItem.mockResolvedValue(null);
    const fireAt = new Date('2099-05-22T12:30:00.000Z');

    await scheduleLocalPomodoroCompletionNotification('Pomodoro Focus', 'Take a break.', fireAt, {
      phase: 'focus-complete',
    });

    expect(mockAlarmScheduleAlarm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Pomodoro Focus',
        message: 'Take a break.',
        play_sound: true,
        schedule_type: 'once',
        fire_date: fireAt.toISOString(),
        data: {
          kind: 'pomodoro',
          phase: 'focus-complete',
        },
      })
    );
    expect(mockAsyncStorageSetItem).toHaveBeenCalledWith(
      'mindwtr:local:pomodoro-alarm:v1',
      JSON.stringify({ id: 99, fireAtMs: fireAt.getTime() })
    );
  });

  it('cancels the superseded pomodoro alarm only after its replacement is scheduled', async () => {
    mockAsyncStorageGetItem.mockImplementation(async (key: string) => (
      key === 'mindwtr:local:pomodoro-alarm:v1'
        ? JSON.stringify({ id: 41, fireAtMs: Date.now() + 60_000 })
        : null
    ));
    const fireAt = new Date('2099-05-22T12:30:00.000Z');

    await scheduleLocalPomodoroCompletionNotification('Pomodoro Focus', 'Take a break.', fireAt);

    expect(mockAlarmScheduleAlarm).toHaveBeenCalledTimes(1);
    expect(mockAlarmDeleteAlarm).toHaveBeenCalledWith(41);
    const scheduleOrder = mockAlarmScheduleAlarm.mock.invocationCallOrder[0];
    const deleteOrder = mockAlarmDeleteAlarm.mock.invocationCallOrder[0];
    expect(scheduleOrder).toBeLessThan(deleteOrder);
    expect(mockAsyncStorageSetItem).toHaveBeenCalledWith(
      'mindwtr:local:pomodoro-alarm:v1',
      JSON.stringify({ id: 99, fireAtMs: fireAt.getTime() })
    );
  });

  it('keeps the fresh pomodoro alarm when the module reuses the previous identifier', async () => {
    mockAsyncStorageGetItem.mockImplementation(async (key: string) => (
      key === 'mindwtr:local:pomodoro-alarm:v1'
        ? JSON.stringify({ id: 99, fireAtMs: Date.now() + 60_000 })
        : null
    ));
    const fireAt = new Date('2099-05-22T12:30:00.000Z');

    await scheduleLocalPomodoroCompletionNotification('Pomodoro Focus', 'Take a break.', fireAt);

    expect(mockAlarmScheduleAlarm).toHaveBeenCalledTimes(1);
    expect(mockAlarmDeleteAlarm).not.toHaveBeenCalled();
    expect(mockAlarmDeleteRepeatingAlarm).not.toHaveBeenCalled();
  });

  it('cancels a pending pomodoro completion alarm', async () => {
    mockAsyncStorageGetItem.mockImplementation(async (key: string) => (
      key === 'mindwtr:local:pomodoro-alarm:v1'
        ? JSON.stringify({ id: 41, fireAtMs: Date.now() + 60_000 })
        : null
    ));

    await cancelLocalPomodoroCompletionNotification();

    expect(mockAlarmDeleteAlarm).toHaveBeenCalledWith(41);
    expect(mockAlarmDeleteRepeatingAlarm).toHaveBeenCalledWith(41);
    expect(mockAlarmRemoveFiredNotification).toHaveBeenCalledWith(41);
    expect(mockAsyncStorageRemoveItem).toHaveBeenCalledWith('mindwtr:local:pomodoro-alarm:v1');
  });

  it('keeps an already fired pomodoro notification visible while clearing its stored alarm', async () => {
    mockAsyncStorageGetItem.mockImplementation(async (key: string) => (
      key === 'mindwtr:local:pomodoro-alarm:v1'
        ? JSON.stringify({ id: 41, fireAtMs: Date.now() - 1000 })
        : null
    ));

    await cancelLocalPomodoroCompletionNotification();

    expect(mockAlarmDeleteAlarm).toHaveBeenCalledWith(41);
    expect(mockAlarmDeleteRepeatingAlarm).toHaveBeenCalledWith(41);
    expect(mockAlarmRemoveFiredNotification).not.toHaveBeenCalled();
    expect(mockAsyncStorageRemoveItem).toHaveBeenCalledWith('mindwtr:local:pomodoro-alarm:v1');
  });
});
