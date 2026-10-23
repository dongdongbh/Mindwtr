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

// A reminder id in this shape doubles as core's capture id, which makes it the
// task id: adding the same reminder twice then returns the first task instead
// of a duplicate. Older ids keep the legacy path. Same rule as pending captures.
const UUID_PATTERN = /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i;

// The manual button and the foreground auto-import both read the imported-id
// list at start; running them at the same time would add a reminder twice.
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

// The imported-id list is the only setting the import owns. It re-reads the
// rest right before writing, so a list or switch the user changed during the
// run keeps its new value. One write per imported reminder: imports are rare
// and bounded by the list, and the id must be durable before the next add.
const persistImportedIds = async (importedIds: Set<string>): Promise<void> => {
  const latest = await loadAppleRemindersImportSettings();
  await saveAppleRemindersImportSettings({ ...latest, importedReminderIds: Array.from(importedIds) });
};

/**
 * Read, change and write the stored settings in one queued step. Settings
 * writes share the import queue so a switch flipped while an import is running
 * is neither lost nor put back to its old value when the run ends (#1238).
 */
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
  /**
   * Resolves once the store's queued snapshot is on disk. `addTask` only
   * schedules a debounced save, so without this the import would call a
   * reminder done while its task lives in memory only.
   */
  flushPendingSave: () => Promise<void>;
  /** Reads the current store after the flush so tombstone replays stay failed. */
  getTaskById: (id: string) => Task | undefined;
  listId: string;
  deleteImportedReminders?: boolean;
};

export function importAppleRemindersIntoInbox(options: AppleRemindersImportOptions): Promise<AppleRemindersImportResult> {
  return serializeImport(() => runAppleRemindersImport(options));
}

/**
 * Foreground auto-import (#1238): runs the same import as the settings button
 * when the user turned it on and a list is chosen. Never prompts for
 * permission; returns null when nothing ran.
 */
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

    // The task is only in memory until this resolves. Everything that says
    // "this reminder is done" — the id list and the delete — waits for it, so
    // a kill in the gap re-imports the reminder instead of losing it.
    try {
      await flushPendingSave();
    } catch {
      // Not recorded and not deleted: the next run picks this reminder up
      // again. Stop here rather than add tasks that cannot be saved either.
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
    // Written down before the next reminder is touched: if iOS ends the app
    // mid-run, what was already added is never imported a second time.
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
