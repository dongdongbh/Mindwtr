import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as Calendar from 'expo-calendar';
import {
  classifyAppleReminderForImport,
  normalizeAppleRemindersImportSettings,
  type AppleReminderList,
  type AppleRemindersImportResult,
  type AppleRemindersImportSettings,
  type StoreActionResult,
  type Task,
} from '@mindwtr/core';

import { logWarn } from './app-log';

export const APPLE_REMINDERS_IMPORT_SETTINGS_KEY = 'mindwtr-apple-reminders-import-v1';

export type AppleRemindersPermissionStatus = 'unavailable' | 'undetermined' | 'granted' | 'denied';

export { normalizeAppleRemindersImportSettings };
export type { AppleReminderList, AppleRemindersImportResult, AppleRemindersImportSettings };

export type AddInboxTask = (
  title: string,
  props?: Partial<Task>,
  options?: { captureId: string },
) => Promise<StoreActionResult>;


const UUID_PATTERN = /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i;


let importChain: Promise<unknown> = Promise.resolve();
const serializeImport = <T>(run: () => Promise<T>): Promise<T> => {
  const next = importChain.then(run, run);
  importChain = next.catch(() => undefined);
  return next;
};

const normalizeString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizePermissionStatus = (status: unknown): AppleRemindersPermissionStatus => {
  if (status === 'granted' || status === 'denied' || status === 'undetermined') return status;
  return 'denied';
};

export async function loadAppleRemindersImportSettings(): Promise<AppleRemindersImportSettings> {
  const raw = await AsyncStorage.getItem(APPLE_REMINDERS_IMPORT_SETTINGS_KEY);
  if (!raw) return normalizeAppleRemindersImportSettings(undefined);
  try {
    return normalizeAppleRemindersImportSettings(JSON.parse(raw));
  } catch {
    return normalizeAppleRemindersImportSettings(undefined);
  }
}

export async function saveAppleRemindersImportSettings(settings: AppleRemindersImportSettings): Promise<void> {
  const normalized = normalizeAppleRemindersImportSettings(settings);
  await AsyncStorage.setItem(APPLE_REMINDERS_IMPORT_SETTINGS_KEY, JSON.stringify(normalized));
}


const persistImportedIds = async (importedIds: Set<string>): Promise<void> => {
  const latest = await loadAppleRemindersImportSettings();
  await saveAppleRemindersImportSettings({ ...latest, importedReminderIds: Array.from(importedIds) });
};


export function updateAppleRemindersImportSettings(
  apply: (current: AppleRemindersImportSettings) => AppleRemindersImportSettings,
): Promise<AppleRemindersImportSettings> {
  return serializeImport(async () => {
    const next = normalizeAppleRemindersImportSettings(apply(await loadAppleRemindersImportSettings()));
    await saveAppleRemindersImportSettings(next);
    return next;
  });
}

export async function getAppleRemindersPermissionStatus(): Promise<AppleRemindersPermissionStatus> {
  if (Platform.OS !== 'ios') return 'unavailable';
  try {
    const result = await Calendar.getRemindersPermissionsAsync();
    return normalizePermissionStatus(result.status);
  } catch {
    return 'denied';
  }
}

export async function requestAppleRemindersPermission(): Promise<AppleRemindersPermissionStatus> {
  if (Platform.OS !== 'ios') return 'unavailable';
  try {
    const result = await Calendar.requestRemindersPermissionsAsync();
    return normalizePermissionStatus(result.status);
  } catch {
    return 'denied';
  }
}

export async function getAppleReminderLists(): Promise<AppleReminderList[]> {
  if (Platform.OS !== 'ios') return [];
  const permission = await getAppleRemindersPermissionStatus();
  if (permission !== 'granted') return [];

  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.REMINDER);
  const lists: AppleReminderList[] = [];
  for (const calendar of calendars) {
    const id = normalizeString(calendar.id);
    if (!id) continue;
    const legacyName = normalizeString((calendar as Calendar.Calendar & { name?: string }).name);
    const color = normalizeString(calendar.color);
    lists.push({
      id,
      title: normalizeString(calendar.title) ?? legacyName ?? 'Reminders',
      ...(color ? { color } : {}),
    });
  }
  return lists.sort((a, b) => a.title.localeCompare(b.title));
}

export type AppleRemindersImportOptions = {
  addTask: AddInboxTask;
  createRecoverySnapshot: () => Promise<unknown>;


  flushPendingSave: () => Promise<void>;

  getTaskById: (id: string) => Task | undefined;
  listId: string;
  deleteImportedReminders?: boolean;
};

export function importAppleRemindersIntoInbox(options: AppleRemindersImportOptions): Promise<AppleRemindersImportResult> {
  return serializeImport(() => runAppleRemindersImport(options));
}


export async function runAppleRemindersAutoImport({
  addTask,
  createRecoverySnapshot,
  flushPendingSave,
  getTaskById,
}: Pick<AppleRemindersImportOptions, 'addTask' | 'createRecoverySnapshot' | 'flushPendingSave' | 'getTaskById'>): Promise<AppleRemindersImportResult | null> {
  if (Platform.OS !== 'ios') return null;
  const settings = await loadAppleRemindersImportSettings();
  if (!settings.autoImportOnOpen || !settings.selectedListId) return null;
  if ((await getAppleRemindersPermissionStatus()) !== 'granted') return null;
  return importAppleRemindersIntoInbox({
    addTask,
    createRecoverySnapshot,
    flushPendingSave,
    getTaskById,
    listId: settings.selectedListId,
    deleteImportedReminders: settings.deleteImportedReminders,
  });
}

async function runAppleRemindersImport({
  addTask,
  createRecoverySnapshot,
  flushPendingSave,
  getTaskById,
  listId,
  deleteImportedReminders,
}: AppleRemindersImportOptions): Promise<AppleRemindersImportResult> {
  if (Platform.OS !== 'ios') {
    throw new Error('Apple Reminders import is only available on iOS.');
  }

  const permission = await getAppleRemindersPermissionStatus();
  if (permission !== 'granted') {
    throw new Error('Apple Reminders permission is required.');
  }

  const normalizedListId = normalizeString(listId);
  if (!normalizedListId) {
    throw new Error('Choose an Apple Reminders list first.');
  }

  const settings = await loadAppleRemindersImportSettings();
  const importedIds = new Set(settings.importedReminderIds);
  const shouldDeleteImported = deleteImportedReminders ?? settings.deleteImportedReminders;
  const reminders = await Calendar.getRemindersAsync([normalizedListId], null, null, null);
  const result: AppleRemindersImportResult = {
    importedCount: 0,
    deletedCount: 0,
    deleteFailedCount: 0,
    skippedDuplicateCount: 0,
    skippedCompletedCount: 0,
    skippedEmptyTitleCount: 0,
    failedCount: 0,
  };
  let recoverySnapshotCreated = false;

  for (const reminder of reminders) {
    const classification = classifyAppleReminderForImport(reminder, normalizedListId, importedIds);
    if (classification.kind === 'completed') {
      result.skippedCompletedCount += 1;
      continue;
    }

    if (classification.kind === 'empty-title') {
      result.skippedEmptyTitleCount += 1;
      continue;
    }

    if (classification.kind === 'duplicate') {
      result.skippedDuplicateCount += 1;
      continue;
    }

    const reminderKey = classification.importKey;
    if (!recoverySnapshotCreated) {
      await createRecoverySnapshot();
      recoverySnapshotCreated = true;
    }
    const reminderId = normalizeString(reminder.id);
    const captureOptions: [{ captureId: string }?] = reminderId && UUID_PATTERN.test(reminderId)
      ? [{ captureId: reminderId.toLowerCase() }]
      : [];
    const taskResult = await addTask(classification.title, classification.props, ...captureOptions);

    if (taskResult.success === false) {
      result.failedCount += 1;
      continue;
    }


    try {
      await flushPendingSave();
    } catch {


      result.failedCount += 1;
      break;
    }

    const resolvedTask = taskResult.id ? getTaskById(taskResult.id) : undefined;
    if (!resolvedTask || resolvedTask.deletedAt || resolvedTask.purgedAt) {
      result.failedCount += 1;
      await logWarn('Apple Reminders import kept source because the resolved task is not live', {
        scope: 'import',
        extra: { releaseCheck: 'v1.3.2/reminder-live-import-guard' },
      });
      continue;
    }

    result.importedCount += 1;
    importedIds.add(reminderKey);


    await persistImportedIds(importedIds);

    if (shouldDeleteImported) {
      if (!reminderId) {
        result.deleteFailedCount += 1;
        continue;
      }

      try {
        await Calendar.deleteReminderAsync(reminderId);
        result.deletedCount += 1;
      } catch {
        result.deleteFailedCount += 1;
      }
    }
  }

  return result;
}
