import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeSandboxRuntime } from '@mindwtr/core';


const localModule = vi.hoisted(() => ({
  getLocalNotificationPermissionStatus: vi.fn(async () => ({ granted: true, canAskAgain: true })),
  cancelLocalPomodoroCompletionNotification: vi.fn(async () => undefined),
  requestLocalNotificationPermission: vi.fn(async () => ({ granted: true, canAskAgain: true })),
  rescheduleLocalAlarmsAsExact: vi.fn(async () => undefined),
  scheduleLocalPomodoroCompletionNotification: vi.fn(async () => undefined),
  sendLocalMobileNotification: vi.fn(async () => undefined),
  setLocalNotificationOpenHandler: vi.fn(() => undefined),
  startLocalMobileNotifications: vi.fn(async () => undefined),
  stopLocalMobileNotifications: vi.fn(async () => undefined),
}));

vi.mock('./notification-service-local', () => localModule);

import {
  cancelMobilePomodoroCompletionNotification,
  getNotificationPermissionStatus,
  requestNotificationPermission,
  rescheduleMobileAlarmsAsExact,
  scheduleMobilePomodoroCompletionNotification,
  sendMobileImmediateNotification,
  setNotificationOpenHandler,
  startMobileNotifications,
  stopMobileNotifications,
} from './notification-service';

describe('notification-service in sandbox mode', () => {
  beforeAll(() => {
    initializeSandboxRuntime(true);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs every entry point without touching the notification platform', async () => {
    setNotificationOpenHandler(() => undefined);
    await startMobileNotifications();
    await rescheduleMobileAlarmsAsExact();
    await sendMobileImmediateNotification('Title', 'Message', { taskId: 'task-1' });
    await scheduleMobilePomodoroCompletionNotification(
      'Pomodoro',
      'Done',
      new Date('2026-05-01T10:00:00.000Z'),
    );
    await cancelMobilePomodoroCompletionNotification('test');
    await stopMobileNotifications();

    for (const [name, mock] of Object.entries(localModule)) {
      expect(mock, `${name} was called in sandbox mode`).not.toHaveBeenCalled();
    }
  });

  it('reports no notification permission instead of asking the system', async () => {
    await expect(requestNotificationPermission()).resolves.toEqual({ granted: false, canAskAgain: false });
    await expect(getNotificationPermissionStatus()).resolves.toEqual({ granted: false, canAskAgain: false });

    expect(localModule.requestLocalNotificationPermission).not.toHaveBeenCalled();
    expect(localModule.getLocalNotificationPermissionStatus).not.toHaveBeenCalled();
  });
});
