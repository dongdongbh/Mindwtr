import {
  getLocalNotificationPermissionStatus,
  requestLocalNotificationPermission,
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
  kind?: string;
};

type NotificationOpenHandler = (payload: NotificationOpenPayload) => void;

type NotificationPermissionResult = {
  granted: boolean;
  canAskAgain: boolean;
};

export function setNotificationOpenHandler(handler: NotificationOpenHandler | null): void {
  setLocalNotificationOpenHandler(handler);
}

export async function requestNotificationPermission(): Promise<NotificationPermissionResult> {
  return requestLocalNotificationPermission();
}

export async function getNotificationPermissionStatus(): Promise<NotificationPermissionResult> {
  return getLocalNotificationPermissionStatus();
}

export async function startMobileNotifications(): Promise<void> {
  await startLocalMobileNotifications();
}

export async function stopMobileNotifications(): Promise<void> {
  await stopLocalMobileNotifications();
}

export async function sendMobileImmediateNotification(
  title: string,
  message?: string,
  data?: Record<string, string>
): Promise<void> {
  await sendLocalMobileNotification(title, message, data);
}
