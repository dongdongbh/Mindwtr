import { strFromU8 } from 'fflate';

import { safeParseDate } from '../date';
import { buildRRuleString } from '../recurrence';
import type {
  AppData,
  ChecklistItem,
  RecurrenceByDay,
  RecurrenceWeekday,
  Task,
  TaskPriority,
  TaskStatus,
} from '../types';

export const DGT_ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
export const DGT_AREA_FALLBACK = 'Imported Area';
export const DGT_PROJECT_FALLBACK = 'Imported Project';
export const DGT_TASK_FALLBACK = 'Imported Task';
export const DGT_IMPORT_SUFFIX = ' (DGT)';
export const DGT_TYPE_TASK = 0;
export const DGT_TYPE_PROJECT = 1;
export const DGT_TYPE_CHECKLIST = 2;
export const DGT_TYPE_CHECKLIST_ITEM = 3;
export const DGT_STATUS_NONE = 0;
export const DGT_STATUS_NEXT_ACTION = 1;

const WEEKDAY_CODES: RecurrenceWeekday[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const WEEKDAY_ALIASES: Record<string, RecurrenceWeekday> = {
  sunday: 'SU',
  sun: 'SU',
  monday: 'MO',
  mon: 'MO',
  tuesday: 'TU',
  tue: 'TU',
  tues: 'TU',
  wednesday: 'WE',
  wed: 'WE',
  thursday: 'TH',
  thu: 'TH',
  thur: 'TH',
  thurs: 'TH',
  friday: 'FR',
  fri: 'FR',
  saturday: 'SA',
  sat: 'SA',
};

const ORDINAL_ALIASES: Record<string, number> = {
  first: 1,
  '1st': 1,
  second: 2,
  '2nd': 2,
  third: 3,
  '3rd': 3,
  fourth: 4,
  '4th': 4,
  last: -1,
};

export type DgtWarningCounters = {
  emptyExports: number;
  invalidJsonFiles: number;
  nestedZipFiles: number;
  nonJsonEntries: number;
  orphanChecklistItems: number;
  unknownTaskTypes: number;
  unmappedStatuses: number;
  unsupportedRepeats: number;
};

export type ParsedDgtArea = {
  color?: string;
  createdAt?: string;
  name: string;
  order: number;
  sourceId: number;
  updatedAt?: string;
};

export type ParsedDgtProject = {
  areaSourceId?: number;
  color?: string;
  createdAt?: string;
  dueDate?: string;
  isArchived?: boolean;
  name: string;
  order: number;
  sourceId: number;
  supportNotes?: string;
  updatedAt?: string;
};

export type ParsedDgtTask = {
  areaSourceId?: number;
  checklist: ChecklistItem[];
  completedAt?: string;
  contexts: string[];
  createdAt?: string;
  description?: string;
  dueDate?: string;
  order: number;
  priority?: TaskPriority;
  projectSourceId?: number;
  recurrence?: Task['recurrence'];
  sourceId: number;
  startTime?: string;
  status: TaskStatus;
  tags: string[];
  title: string;
  updatedAt?: string;
};

export type ParsedDgtImportData = {
  areas: ParsedDgtArea[];
  projects: ParsedDgtProject[];
  tasks: ParsedDgtTask[];
  warnings: string[];
};

export type DgtImportProjectPreview = {
  areaName?: string;
  name: string;
  taskCount: number;
};

export type DgtImportPreview = {
  areaCount: number;
  checklistItemCount: number;
  fileName: string;
  projectCount: number;
  projects: DgtImportProjectPreview[];
  recurringCount: number;
  standaloneTaskCount: number;
  taskCount: number;
  warnings: string[];
};

export type DgtImportParseResult = {
  errors: string[];
  parsedData: ParsedDgtImportData | null;
  preview: DgtImportPreview | null;
  valid: boolean;
  warnings: string[];
};

export type DgtImportExecutionResult = {
  data: AppData;
  importedAreaCount: number;
  importedChecklistItemCount: number;
  importedProjectCount: number;
  importedTaskCount: number;
  warnings: string[];
};

export const createWarningCounters = (): DgtWarningCounters => ({
  emptyExports: 0,
  invalidJsonFiles: 0,
  nestedZipFiles: 0,
  nonJsonEntries: 0,
  orphanChecklistItems: 0,
  unknownTaskTypes: 0,
  unmappedStatuses: 0,
  unsupportedRepeats: 0,
});

const appendWarning = (warnings: string[], count: number, singular: string, plural = singular): void => {
  if (count <= 0) return;
  warnings.push(count === 1 ? singular : plural.replace('{count}', String(count)));
};

export const buildWarnings = (counters: DgtWarningCounters): string[] => {
  const warnings: string[] = [];
  appendWarning(
    warnings,
    counters.unsupportedRepeats,
    '1 DGT recurring task could not be mapped and will be imported once.',
    '{count} DGT recurring tasks could not be mapped and will be imported once.'
  );
  appendWarning(
    warnings,
    counters.unmappedStatuses,
    '1 DGT task status could not be mapped and was imported to Inbox.',
    '{count} DGT task statuses could not be mapped and were imported to Inbox.'
  );
  appendWarning(
    warnings,
    counters.orphanChecklistItems,
    '1 DGT checklist item had no parent checklist and was imported as a normal task.',
    '{count} DGT checklist items had no parent checklist and were imported as normal tasks.'
  );
  appendWarning(
    warnings,
    counters.unknownTaskTypes,
    '1 DGT item type was imported as a normal task.',
    '{count} DGT item types were imported as normal tasks.'
  );
  appendWarning(
    warnings,
    counters.nonJsonEntries,
    '1 non-JSON file inside the DGT archive was skipped.',
    '{count} non-JSON files inside the DGT archive were skipped.'
  );
  appendWarning(
    warnings,
    counters.nestedZipFiles,
    '1 nested ZIP file inside the DGT archive was skipped.',
    '{count} nested ZIP files inside the DGT archive were skipped.'
  );
  appendWarning(
    warnings,
    counters.invalidJsonFiles,
    '1 DGT JSON file could not be parsed and was skipped.',
    '{count} DGT JSON files could not be parsed and were skipped.'
  );
  appendWarning(
    warnings,
    counters.emptyExports,
    '1 DGT export contained no importable tasks or projects.',
    '{count} DGT exports contained no importable tasks or projects.'
  );
  return warnings;
};

export const basename = (value: string): string => {
  const parts = String(value || '').split(/[\\/]/u);
  return parts[parts.length - 1] || value;
};

export const toUint8Array = (value?: ArrayBuffer | Uint8Array | null): Uint8Array | null => {
  if (!value) return null;
  return value instanceof Uint8Array ? value : new Uint8Array(value);
};

export const isZipBytes = (bytes: Uint8Array): boolean =>
  bytes.length >= DGT_ZIP_SIGNATURE.length &&
  DGT_ZIP_SIGNATURE.every((byte, index) => bytes[index] === byte);

export const decodeTextBytes = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return strFromU8(bytes, true);
  }
};

export const sanitizeJsonText = (raw: string): string => String(raw || '').replace(/^\uFEFF/u, '').trim();

export const toRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export const toStringValue = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export const toNumberValue = (value: unknown, fallback = 0): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

export const toPositiveInt = (value: unknown): number | undefined => {
  const parsed = Math.trunc(toNumberValue(value, 0));
  return parsed > 0 ? parsed : undefined;
};

export const toBooleanFlag = (value: unknown): boolean => toNumberValue(value, 0) === 1;

export const toIntegerArray = (value: unknown): number[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => toPositiveInt(entry))
    .filter((entry): entry is number => entry !== undefined);
};

export const normalizeDateString = (value: unknown, hasTime: boolean): string | undefined => {
  const trimmed = toStringValue(value);
  if (!trimmed) return undefined;
  const dateOnlyMatch = /^(\d{4}-\d{2}-\d{2})$/u.exec(trimmed);
  if (dateOnlyMatch) {
    return dateOnlyMatch[1];
  }
  const dateTimeMatch = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)$/u.exec(trimmed);
  if (!dateTimeMatch) return undefined;
  return hasTime ? `${dateTimeMatch[1]}T${dateTimeMatch[2]}` : dateTimeMatch[1];
};

export const normalizeTitle = (value: unknown, fallback: string): string => toStringValue(value) || fallback;

export const normalizeColor = (value: unknown): string | undefined => {
  if (value === '' || value === null || value === undefined) return undefined;
  const parsed = Math.trunc(toNumberValue(value, Number.NaN));
  if (!Number.isFinite(parsed)) return undefined;
  const hex = (parsed >>> 0).toString(16).padStart(8, '0').slice(-6);
  return `#${hex.toLowerCase()}`;
};

export const normalizeOrder = (value: unknown, fallback: number): number => {
  const parsed = Math.trunc(toNumberValue(value, fallback));
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const normalizeContextName = (value: string): string | undefined => {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
};

export const normalizeTagName = (value: string): string | undefined => {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
};

export const dedupeStrings = (values: Array<string | undefined>): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value) => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return;
    const normalized = trimmed.toLowerCase();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    result.push(trimmed);
  });
  return result;
};

export const joinDescription = (parts: Array<string | undefined>): string | undefined => {
  const normalized = parts.map((part) => String(part || '').trim()).filter(Boolean);
  return normalized.length > 0 ? normalized.join('\n\n') : undefined;
};

export const normalizePriority = (priorityValue: number, starred: boolean): TaskPriority | undefined => {
  if (starred) return 'urgent';
  switch (priorityValue) {
    case 4:
      return 'urgent';
    case 3:
      return 'high';
    case 2:
      return 'medium';
    case 1:
      return 'low';
    default:
      return undefined;
  }
};

const weekdayFromDate = (isoString?: string): RecurrenceWeekday | undefined => {
  const parsed = safeParseDate(isoString);
  if (!parsed) return undefined;
  return WEEKDAY_CODES[parsed.getDay()];
};

const parseOrdinalToken = (value: string): number | undefined => ORDINAL_ALIASES[value.trim().toLowerCase()];

const parseWeekdayToken = (value: string): RecurrenceWeekday | undefined => WEEKDAY_ALIASES[value.trim().toLowerCase()];

const buildIntervalRecurrence = (rule: 'daily' | 'weekly' | 'monthly' | 'yearly', interval = 1): Task['recurrence'] => {
  if (!Number.isFinite(interval) || interval <= 1) return { rule };
  return {
    rule,
    rrule: `FREQ=${rule.toUpperCase()};INTERVAL=${Math.trunc(interval)}`,
  };
};

const buildMonthlyByDayRecurrence = (byDay: RecurrenceByDay, interval = 1): Task['recurrence'] => ({
  rule: 'monthly',
  rrule: buildRRuleString('monthly', [byDay], interval),
});

const buildWeeklyByDayRecurrence = (byDay: RecurrenceWeekday, interval = 1): Task['recurrence'] => ({
  rule: 'weekly',
  rrule: buildRRuleString('weekly', [byDay], interval),
});

export const resolveRepeatPattern = (
  repeatText: string,
  anchorDate?: string
): { recurrence?: Task['recurrence']; unsupported?: true } => {
  const trimmed = repeatText.trim();
  if (!trimmed) return {};

  if (/^daily$/iu.test(trimmed)) {
    return { recurrence: { rule: 'daily' } };
  }
  if (/^weekly$/iu.test(trimmed)) {
    const weekday = weekdayFromDate(anchorDate);
    return weekday ? { recurrence: buildWeeklyByDayRecurrence(weekday) } : { recurrence: { rule: 'weekly' } };
  }
  if (/^monthly$/iu.test(trimmed)) {
    return { recurrence: { rule: 'monthly' } };
  }
  if (/^(yearly|annually)$/iu.test(trimmed)) {
    return { recurrence: { rule: 'yearly' } };
  }
  if (/^quarterly$/iu.test(trimmed)) {
    return { recurrence: buildIntervalRecurrence('monthly', 3) };
  }

  const everyWeekdayMatch = /^every\s+([a-z]+)$/iu.exec(trimmed);
  if (everyWeekdayMatch) {
    const weekday = parseWeekdayToken(everyWeekdayMatch[1]);
    if (weekday) {
      return { recurrence: buildWeeklyByDayRecurrence(weekday) };
    }
  }

  const everyIntervalMatch = /^every\s+(\d+)\s+(day|days|week|weeks|month|months|year|years)$/iu.exec(trimmed);
  if (everyIntervalMatch) {
    const interval = Number(everyIntervalMatch[1]);
    const unit = everyIntervalMatch[2].toLowerCase();
    if (unit.startsWith('day')) return { recurrence: buildIntervalRecurrence('daily', interval) };
    if (unit.startsWith('week')) return { recurrence: buildIntervalRecurrence('weekly', interval) };
    if (unit.startsWith('month')) return { recurrence: buildIntervalRecurrence('monthly', interval) };
    if (unit.startsWith('year')) return { recurrence: buildIntervalRecurrence('yearly', interval) };
  }

  const ordinalMonthMatch = /^(?:the|every)\s+([a-z0-9]+)\s+([a-z]+)\s+every\s+(\d+)\s+months?$/iu.exec(trimmed);
  if (ordinalMonthMatch) {
    const ordinal = parseOrdinalToken(ordinalMonthMatch[1]);
    const weekday = parseWeekdayToken(ordinalMonthMatch[2]);
    const interval = Number(ordinalMonthMatch[3]);
    if (ordinal !== undefined && weekday) {
      return { recurrence: buildMonthlyByDayRecurrence(`${ordinal}${weekday}` as RecurrenceByDay, interval) };
    }
  }

  if (/^last day of every \d+ months?$/iu.test(trimmed) || /^last day of every month$/iu.test(trimmed)) {
    return { unsupported: true };
  }

  return { unsupported: true };
};

export const resolveTaskStatus = (
  statusValue: number,
  completedAt: string | undefined,
  counters: DgtWarningCounters
): { completedAt?: string; status: TaskStatus } => {
  if (completedAt) {
    return {
      status: 'done',
      completedAt,
    };
  }
  if (statusValue === DGT_STATUS_NONE) {
    return { status: 'inbox' };
  }
  if (statusValue === DGT_STATUS_NEXT_ACTION) {
    return { status: 'next' };
  }
  counters.unmappedStatuses += 1;
  return { status: 'inbox' };
};

export const resolveUniqueName = (title: string, usedTitles: Set<string>, fallback: string): string => {
  const trimmed = title.trim() || fallback;
  if (!usedTitles.has(trimmed.toLowerCase())) {
    usedTitles.add(trimmed.toLowerCase());
    return trimmed;
  }

  const base = `${trimmed}${DGT_IMPORT_SUFFIX}`;
  if (!usedTitles.has(base.toLowerCase())) {
    usedTitles.add(base.toLowerCase());
    return base;
  }

  let suffix = 2;
  while (true) {
    const next = `${base} ${suffix}`;
    const normalized = next.toLowerCase();
    if (!usedTitles.has(normalized)) {
      usedTitles.add(normalized);
      return next;
    }
    suffix += 1;
  }
};

export const resolveTimestamp = (value: string | undefined, fallback: string): string => {
  const parsed = safeParseDate(value);
  return parsed ? (value as string) : fallback;
};
