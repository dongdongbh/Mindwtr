import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

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

const nativeModule = Platform.OS === 'android'
  ? requireOptionalNativeModule<NotificationOpenIntentsModule>('NotificationOpenIntents')
  : null;

function parseNestedPayloadData(value: string | undefined): Record<string, string> {
  if (!value) return {};
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

export async function consumePendingNotificationOpenPayload(): Promise<NotificationOpenPayload | null> {
  const payload = nativeModule?.consumePendingOpenPayload?.();
  if (!payload) return null;
  const nestedData = parseNestedPayloadData(payload.data);
  return {
    notificationId: payload.alarmKey || payload.id || nestedData.alarmKey || nestedData.id,
    actionIdentifier: 'open',
    taskId: payload.taskId || nestedData.taskId,
    projectId: payload.projectId || nestedData.projectId,
    kind: payload.kind || nestedData.kind,
  };
}
