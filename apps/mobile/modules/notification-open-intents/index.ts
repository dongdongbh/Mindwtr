import { requireOptionalNativeModule } from 'expo-modules-core';
import { NativeModules, Platform } from 'react-native';

type NotificationOpenPayload = {
  notificationId?: string;
  actionIdentifier?: string;
  taskId?: string;
  projectId?: string;
  kind?: string;
};

type NotificationOpenIntentsModule = {
  consumePendingOpenPayload(): Record<string, string> | null;
};

type AlarmNotificationModule = {
  consumePendingNotificationOpenPayload?: () => Promise<Record<string, unknown> | null>;
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
    notificationId: stringifyPayloadValue(payload.alarmKey) || stringifyPayloadValue(payload.id) || nestedData.alarmKey || nestedData.id,
    actionIdentifier: stringifyPayloadValue(payload.actionIdentifier) || nestedData.actionIdentifier || 'open',
    taskId: stringifyPayloadValue(payload.taskId) || nestedData.taskId,
    projectId: stringifyPayloadValue(payload.projectId) || nestedData.projectId,
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
