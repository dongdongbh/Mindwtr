import { requireOptionalNativeModule } from 'expo-modules-core';
import { NativeModules, Platform } from 'react-native';

export type NotificationOpenPayload = {
  actionId?: string;
  notificationId?: string;
  actionIdentifier?: string;
  taskId?: string;
  projectId?: string;
  context?: string;
  kind?: string;
};

type NotificationOpenIntentsModule = {
  consumePendingOpenPayload(): Record<string, string> | null;
  peekPendingCompletions?: () => Record<string, string>[];
  acknowledgeCompletion?: (actionId: string) => void;
  ensureReminderChannel?: (channelId: string, channelName: string) => void;
  showPersistentCaptureNotification?: (title: string, text: string, channelName: string) => void;
  hidePersistentCaptureNotification?: () => void;
  restorePersistentCaptureNotification?: () => void;
};

type AlarmNotificationModule = {
  consumePendingNotificationOpenPayload?: () => Promise<Record<string, unknown> | null>;
  cancelTaskReminderNotifications?: (taskId: string) => Promise<void>;
};

const nativeModule = Platform.OS === 'android'
  ? requireOptionalNativeModule<NotificationOpenIntentsModule>('NotificationOpenIntents')
  : null;

const alarmNotificationModule = Platform.OS === 'ios'
  ? (NativeModules.RNAlarmNotification as AlarmNotificationModule | undefined)
  : null;

function stringifyPayloadValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return undefined;
  return String(value);
}

function parseNestedPayloadData(value: unknown): Record<string, string> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) {
    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const stringValue = stringifyPayloadValue(item);
      if (stringValue !== undefined) result[key] = stringValue;
    }
    return result;
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof item === 'string') result[key] = item;
      else if (item !== undefined && item !== null) result[key] = String(item);
    }
    return result;
  } catch {
    return {};
  }
}

function normalizePayload(payload: Record<string, unknown>): NotificationOpenPayload {
  const nestedData = parseNestedPayloadData(payload.data);
  return {
    actionId: stringifyPayloadValue(payload.actionId) || nestedData.actionId,
    notificationId: stringifyPayloadValue(payload.alarmKey) || stringifyPayloadValue(payload.id) || nestedData.alarmKey || nestedData.id,
    actionIdentifier: stringifyPayloadValue(payload.actionIdentifier) || nestedData.actionIdentifier || 'open',
    taskId: stringifyPayloadValue(payload.taskId) || nestedData.taskId,
    projectId: stringifyPayloadValue(payload.projectId) || nestedData.projectId,
    context: stringifyPayloadValue(payload.context) || nestedData.context,
    kind: stringifyPayloadValue(payload.kind) || nestedData.kind,
  };
}

export async function consumePendingNotificationOpenPayload(): Promise<NotificationOpenPayload | null> {
  if (Platform.OS === 'android') {
    const payload = nativeModule?.consumePendingOpenPayload?.();
    return payload ? normalizePayload(payload) : null;
  }

  const payload = await alarmNotificationModule?.consumePendingNotificationOpenPayload?.();
  return payload ? normalizePayload(payload) : null;
}

/** Durable Android receipts, oldest first; reading never removes them. */
export async function peekPendingNotificationCompletions(): Promise<NotificationOpenPayload[]> {
  if (Platform.OS !== 'android') return [];
  if (!nativeModule?.peekPendingCompletions) throw new Error('Completion replay unavailable');
  return nativeModule.peekPendingCompletions().map(normalizePayload);
}

export async function acknowledgeNotificationCompletion(actionId: string): Promise<void> {
  if (Platform.OS !== 'android' || !nativeModule?.acknowledgeCompletion) {
    throw new Error('Completion acknowledgement unavailable');
  }
  nativeModule.acknowledgeCompletion(actionId);
}

export async function cancelTaskReminderNotifications(taskId: string): Promise<void> {
  if (Platform.OS !== 'ios' || !alarmNotificationModule?.cancelTaskReminderNotifications) {
    throw new Error('Task reminder cancellation unavailable');
  }
  await alarmNotificationModule.cancelTaskReminderNotifications(taskId);
}

export async function ensureReminderNotificationChannel(channelId: string, channelName: string): Promise<void> {
  if (Platform.OS !== 'android') return;
  nativeModule?.ensureReminderChannel?.(channelId, channelName);
}

// Persistent "quick add" capture notification (#819). Android-only: iOS has no
// ongoing notifications; iOS users capture via the widget or Shortcuts instead.
export function showPersistentCaptureNotification(title: string, text: string, channelName: string): void {
  if (Platform.OS !== 'android') return;
  nativeModule?.showPersistentCaptureNotification?.(title, text, channelName);
}

export function hidePersistentCaptureNotification(): void {
  if (Platform.OS !== 'android') return;
  nativeModule?.hidePersistentCaptureNotification?.();
}

/**
 * Re-post the pinned capture notification from its native last-posted mirror
 * if the toggle is on. Needs no strings, so callers that just wiped the shade
 * (NotificationManager.cancelAll) can re-assert the handle without i18n access.
 */
export function restorePersistentCaptureNotification(): void {
  if (Platform.OS !== 'android') return;
  nativeModule?.restorePersistentCaptureNotification?.();
}
