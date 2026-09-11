import { isSandboxMode } from '@mindwtr/core';

import {
  getLocalNotificationPermissionStatus,
  cancelLocalPomodoroCompletionNotification,
  requestLocalNotificationPermission,
  rescheduleLocalAlarmsAsExact,
  scheduleLocalPomodoroCompletionNotification,
  sendLocalMobileNotification,
  setLocalNotificationOpenHandler,
  startLocalMobileNotifications,
  stopLocalMobileNotifications,
} from './notification-service-local';

type NotificationOpenPayload = {
  notificationId?: string;
  actionIdentifier?: string;
  taskId?: string;
  projectId?: string;
  context?: string;
  kind?: string;
};

type NotificationOpenHandler = (payload: NotificationOpenPayload) => void;

type NotificationPermissionResult = {
  granted: boolean;
  canAskAgain: boolean;
};

export function setNotificationOpenHandler(handler: NotificationOpenHandler | null): void {
  if (isSandboxMode()) return;
  setLocalNotificationOpenHandler(handler);
}

export async function requestNotificationPermission(): Promise<NotificationPermissionResult> {
  if (isSandboxMode()) return { granted: false, canAskAgain: false };
  return requestLocalNotificationPermission();
}

export async function getNotificationPermissionStatus(): Promise<NotificationPermissionResult> {
  if (isSandboxMode()) return { granted: false, canAskAgain: false };
  return getLocalNotificationPermissionStatus();
}

export async function startMobileNotifications(): Promise<void> {
  if (isSandboxMode()) return;
  await startLocalMobileNotifications();
}

export async function rescheduleMobileAlarmsAsExact(): Promise<void> {
  if (isSandboxMode()) return;
  await rescheduleLocalAlarmsAsExact();
}

export async function stopMobileNotifications(): Promise<void> {
  if (isSandboxMode()) return;
  await stopLocalMobileNotifications();
}

export async function sendMobileImmediateNotification(
  title: string,
  message?: string,
  data?: Record<string, string>
): Promise<void> {
  if (isSandboxMode()) return;
  await sendLocalMobileNotification(title, message, data);
}

export async function scheduleMobilePomodoroCompletionNotification(
  title: string,
  message: string,
  fireAt: Date,
  data?: Record<string, string>
): Promise<void> {
  if (isSandboxMode()) return;
  await scheduleLocalPomodoroCompletionNotification(title, message, fireAt, data);
}

export async function cancelMobilePomodoroCompletionNotification(reason?: string): Promise<void> {
  if (isSandboxMode()) return;
  await cancelLocalPomodoroCompletionNotification(undefined, { reason });
}
