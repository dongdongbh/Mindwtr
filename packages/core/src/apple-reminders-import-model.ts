export type AppleRemindersImportSettings = {
  selectedListId?: string;
  selectedListTitle?: string;
  importedReminderIds: string[];
  deleteImportedReminders: boolean;
  /** Run the import each time Mindwtr comes to the foreground (#1238). */
  autoImportOnOpen: boolean;
};

export type AppleReminderList = {
  id: string;
  title: string;
  color?: string;
};

export type AppleRemindersImportResult = {
  importedCount: number;
  deletedCount: number;
  deleteFailedCount: number;
  skippedDuplicateCount: number;
  skippedCompletedCount: number;
  skippedEmptyTitleCount: number;
  failedCount: number;
};

/** Only the provider fields that participate in the existing import policy. */
export type AppleReminderImportSource = {
  id?: unknown;
  title?: unknown;
  notes?: unknown;
  completed?: unknown;
  creationDate?: unknown;
  startDate?: unknown;
  dueDate?: unknown;
};

export type AppleReminderImportClassification =
  | { kind: 'completed' }
  | { kind: 'empty-title' }
  | { kind: 'duplicate' }
  | {
    kind: 'candidate';
    importKey: string;
    sourceId?: string;
    captureId?: string;
    title: string;
    props: { status: 'inbox'; description?: string };
  };

const UUID_PATTERN = /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i;

const DEFAULT_IMPORT_SETTINGS: AppleRemindersImportSettings = {
  importedReminderIds: [],
  deleteImportedReminders: false,
  autoImportOnOpen: false,
};

const normalizeString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeDateKey = (value: unknown): string | undefined => {
  if (value instanceof Date) return value.toISOString();
  return normalizeString(value);
};

const getReminderImportKey = (reminder: AppleReminderImportSource, listId: string, title: string): string => {
  const reminderId = normalizeString(reminder.id);
  if (reminderId) return reminderId;

  return [
    'fallback',
    listId,
    title,
    normalizeString(reminder.notes) ?? '',
    normalizeDateKey(reminder.creationDate) ?? '',
    normalizeDateKey(reminder.startDate) ?? '',
    normalizeDateKey(reminder.dueDate) ?? '',
  ].join(':');
};

export function normalizeAppleRemindersImportSettings(value: unknown): AppleRemindersImportSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_IMPORT_SETTINGS };
  const raw = value as Partial<AppleRemindersImportSettings>;
  const selectedListId = normalizeString(raw.selectedListId);
  const selectedListTitle = normalizeString(raw.selectedListTitle);
  const importedReminderIds = Array.isArray(raw.importedReminderIds)
    ? Array.from(new Set(raw.importedReminderIds.map(normalizeString).filter((id): id is string => Boolean(id))))
    : [];

  return {
    ...(selectedListId ? { selectedListId } : {}),
    ...(selectedListTitle ? { selectedListTitle } : {}),
    importedReminderIds,
    deleteImportedReminders: raw.deleteImportedReminders === true,
    autoImportOnOpen: raw.autoImportOnOpen === true,
  };
}

/** Classification supplies an Inbox seed, never proof of a saved task or authority to delete the source. */
export function classifyAppleReminderForImport(
  source: AppleReminderImportSource,
  listId: string,
  importedIds: ReadonlySet<string>,
): AppleReminderImportClassification {
  if (source.completed === true) return { kind: 'completed' };
  const title = normalizeString(source.title);
  if (!title) return { kind: 'empty-title' };

  const importKey = getReminderImportKey(source, listId, title);
  if (importedIds.has(importKey)) return { kind: 'duplicate' };

  const description = normalizeString(source.notes);
  const sourceId = normalizeString(source.id);
  const captureId = sourceId && UUID_PATTERN.test(sourceId) ? sourceId.toLowerCase() : undefined;
  return {
    kind: 'candidate',
    importKey,
    ...(sourceId ? { sourceId } : {}),
    ...(captureId ? { captureId } : {}),
    title,
    props: {
      status: 'inbox',
      ...(description ? { description } : {}),
    },
  };
}
