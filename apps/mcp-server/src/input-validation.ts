import {
  AREA_NAME_MAX_LENGTH,
  LIST_PAGE_MAX_LIMIT,
  normalizeRecurrenceForLoad,
  normalizeRelativeStartOffset,
  normalizeRepeatReminderMinutes,
  normalizeTimeSpentMinutes,
  RECURRENCE_INTERVAL_MAX,
  type Recurrence,
  type RelativeStartOffset,
} from '@mindwtr/core';
import * as z from 'zod';

import { ValidationError } from './errors.js';

export const MAX_TASK_TITLE_LENGTH = 500;
export const MAX_TASK_QUICK_ADD_LENGTH = 2000;
export const MAX_AREA_NAME_LENGTH = AREA_NAME_MAX_LENGTH;
export const MAX_TASK_LIST_LIMIT = LIST_PAGE_MAX_LIMIT;
export const MAX_TASK_TOKEN_LENGTH = MAX_TASK_TITLE_LENGTH;
export const ISO_DATE_LIKE_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/;
export const isoDateLikeSchema = z
  .string()
  .regex(ISO_DATE_LIKE_PATTERN, 'Expected ISO date (YYYY-MM-DD) or ISO datetime');

const recurrenceRuleSchema = z.enum(['daily', 'weekly', 'monthly', 'yearly']);
const recurrenceRRuleSchema = z.string().trim().max(MAX_TASK_QUICK_ADD_LENGTH).regex(
  /(?:^|;)FREQ=(?:DAILY|WEEKLY|MONTHLY|YEARLY)(?:;|$)/i,
  'Expected an RFC 5545 recurrence rule containing FREQ'
);
const recurrenceByDayPattern = /^(?:[1-4]|-1)?(?:MO|TU|WE|TH|FR|SA|SU)$/;
const recurrenceWeekdayPattern = /^(?:MO|TU|WE|TH|FR|SA|SU)$/;
const recurrenceOrdinalWeekdayPattern = /^(?:[1-4]|-1)(?:MO|TU|WE|TH|FR|SA|SU)$/;
const recurrenceByDaySchema = z.string().regex(
  recurrenceByDayPattern,
  'Expected an RFC 5545 weekday'
);
const recurrenceAnchorDaySchema = z.number().int().min(1).max(31);
// byMonthDay additionally accepts -1: RFC 5545's "last day of the month".
const recurrenceMonthDaySchema = z.union([recurrenceAnchorDaySchema, z.literal(-1)]);
const recurrenceUntilPattern =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?)?$/;
const recurrenceObjectSchema = z.object({
  rule: recurrenceRuleSchema,
  seriesId: z.string().trim().min(1).max(MAX_TASK_TITLE_LENGTH).optional(),
  strategy: z.enum(['strict', 'fluid']).optional(),
  byDay: z.array(recurrenceByDaySchema).optional(),
  byMonthDay: z.array(recurrenceMonthDaySchema).max(31).optional(),
  weekStart: z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']).optional(),
  count: z.number().int().positive().optional(),
  until: z.string().regex(recurrenceUntilPattern, 'Expected ISO date (YYYY-MM-DD) or ISO datetime').optional(),
  completedOccurrences: z.number().int().nonnegative().optional(),
  anchorDay: recurrenceAnchorDaySchema.optional(),
  startAnchorDay: recurrenceAnchorDaySchema.optional(),
  dueAnchorDay: recurrenceAnchorDaySchema.optional(),
  reviewAnchorDay: recurrenceAnchorDaySchema.optional(),
  rrule: recurrenceRRuleSchema.optional(),
}).strict();

export const taskRecurrenceInputSchema = z.union([
  recurrenceRRuleSchema,
  recurrenceObjectSchema,
]);

export type TaskRecurrenceInput = z.infer<typeof taskRecurrenceInputSchema>;

// zod needs each recurrence key's *type*, not just its name, so recurrenceObjectSchema can't
// be generated from TASK_RECURRENCE_FIELD_KEYS outright — but its key set must still match
// that shared list exactly (see input-validation.test.ts's consolidation test). Exported so
// that test can inspect it without duplicating the key list a third time.
export const TASK_RECURRENCE_INPUT_FIELD_KEYS: readonly string[] = Object.keys(recurrenceObjectSchema.shape);

type TaskTokenField = 'contexts' | 'tags';

const TASK_TOKEN_LABELS: Record<TaskTokenField, string> = {
  contexts: 'Context',
  tags: 'Tag',
};

const validateTaskTokenList = (field: TaskTokenField, values: string[]): string[] => {
  const normalized = values.map((value) => value.trim());
  for (const token of normalized) {
    if (!token) {
      throw new ValidationError(`${TASK_TOKEN_LABELS[field]} values must be non-empty strings`);
    }
    if (token.length > MAX_TASK_TOKEN_LENGTH) {
      throw new ValidationError(`${TASK_TOKEN_LABELS[field]} values must be at most ${MAX_TASK_TOKEN_LENGTH} characters`);
    }
  }
  return normalized;
};

export const normalizeOptionalTaskTokens = (
  field: TaskTokenField,
  values: string[] | undefined,
): string[] | undefined => {
  if (values === undefined) return undefined;
  return validateTaskTokenList(field, values);
};

export const normalizeNullableTaskTokens = (
  field: TaskTokenField,
  values: string[] | null | undefined,
): string[] | null | undefined => {
  if (values === undefined || values === null) return values;
  return validateTaskTokenList(field, values);
};

const isPositiveInteger = (value: string): boolean => (
  /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))
);

const isValidRecurrenceUntil = (value: string): boolean => {
  const match = recurrenceUntilPattern.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const [year, month, day] = [yearText, monthText, dayText].map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false;
  if (hourText === undefined) return true;
  if (Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59) return false;
  return Number.isFinite(Date.parse(value));
};

const isValidRRuleUntil = (value: string): boolean => {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/i.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second = '00', utc] = match;
  return isValidRecurrenceUntil(
    hour ? `${year}-${month}-${day}T${hour}:${minute}:${second}${utc ?? ''}` : `${year}-${month}-${day}`
  );
};

const isCompatibleRecurrence = (recurrence: Recurrence): boolean => {
  if (recurrence.until && !isValidRecurrenceUntil(recurrence.until)) return false;
  const byDay = recurrence.byDay ?? [];
  const hasByMonthDay = Boolean(recurrence.byMonthDay?.length);
  if (recurrence.rule === 'weekly') {
    return !hasByMonthDay && byDay.every((day) => recurrenceWeekdayPattern.test(day));
  }
  if (recurrence.rule === 'monthly') {
    return !recurrence.weekStart
      && !(byDay.length && hasByMonthDay)
      && byDay.every((day) => recurrenceOrdinalWeekdayPattern.test(day));
  }
  return !byDay.length && !hasByMonthDay && !recurrence.weekStart;
};

const recurrenceValuesKey = (values: readonly (string | number)[] | undefined): string => (
  (values ?? []).map(String).sort().join(',')
);

const hasSameRecurrenceUntil = (left: string | undefined, right: string | undefined): boolean => {
  if (left === right) return true;
  if (!left || !right || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(left) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(right)) {
    return false;
  }
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && leftTime === rightTime;
};

const hasSameRecurrenceSchedule = (left: Recurrence, right: Recurrence): boolean => (
  left.rule === right.rule
  && recurrenceValuesKey(left.byDay) === recurrenceValuesKey(right.byDay)
  && recurrenceValuesKey(left.byMonthDay) === recurrenceValuesKey(right.byMonthDay)
  && left.weekStart === right.weekStart
  && left.count === right.count
  && hasSameRecurrenceUntil(left.until, right.until)
);

const isSupportedRRule = (value: string): boolean => {
  const seen = new Set<string>();
  for (const token of value.split(';')) {
    const parts = token.split('=');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
    const key = parts[0].toUpperCase();
    const raw = parts[1];
    if (seen.has(key)) return false;
    seen.add(key);
    if (key === 'FREQ' && !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(raw.toUpperCase())) return false;
    if (key === 'INTERVAL' && (!isPositiveInteger(raw) || Number(raw) > RECURRENCE_INTERVAL_MAX)) return false;
    if (key === 'BYDAY' && !raw.split(',').every((day) => recurrenceByDayPattern.test(day.toUpperCase()))) return false;
    if (key === 'BYMONTHDAY' && !raw.split(',').every((day) => isPositiveInteger(day) && Number(day) <= 31)) return false;
    if (key === 'WKST' && !['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'].includes(raw.toUpperCase())) return false;
    if (key === 'COUNT' && !isPositiveInteger(raw)) return false;
    if (key === 'UNTIL' && !isValidRRuleUntil(raw)) return false;
    if (!['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'WKST', 'COUNT', 'UNTIL', 'X-MINDWTR-SERIES-ID'].includes(key)) return false;
  }
  const recurrence = normalizeRecurrenceForLoad(value);
  return seen.has('FREQ') && Boolean(recurrence && isCompatibleRecurrence(recurrence));
};

const normalizeTaskRecurrence = (value: TaskRecurrenceInput): Recurrence => {
  const parsed = taskRecurrenceInputSchema.safeParse(value);
  if (!parsed.success) throw new ValidationError('Invalid task recurrence');
  const rrule = typeof parsed.data === 'string' ? parsed.data : parsed.data.rrule;
  if (rrule && !isSupportedRRule(rrule)) throw new ValidationError('Invalid task recurrence');
  const normalized = normalizeRecurrenceForLoad(parsed.data);
  const rruleRecurrence = rrule ? normalizeRecurrenceForLoad(rrule) : undefined;
  if (
    !normalized
    || !isCompatibleRecurrence(normalized)
    || (
      rrule
      && typeof parsed.data !== 'string'
      && (!rruleRecurrence || !hasSameRecurrenceSchedule(normalized, rruleRecurrence))
    )
  ) {
    throw new ValidationError('Invalid task recurrence');
  }
  return normalized;
};

export const normalizeOptionalTaskRecurrence = (
  value: TaskRecurrenceInput | undefined,
): Recurrence | undefined => (
  value === undefined ? undefined : normalizeTaskRecurrence(value)
);

export const normalizeNullableTaskRecurrence = (
  value: TaskRecurrenceInput | null | undefined,
): Recurrence | null | undefined => (
  value === undefined || value === null ? value : normalizeTaskRecurrence(value)
);

// --- Task fields that need more than structural (Zod) validation ---
// The zod schemas below only check shape; normalizeRelativeStartOffset/normalizeTimeSpent
// Minutes/normalizeRepeatReminderMinutes (imported from core) apply the same semantic checks
// apps/cloud/src/server-validation.ts already runs (validateTaskRelativeStartOffset etc.),
// so both MCP backends reject the same malformed values cloud already rejects.

export const relativeStartOffsetInputSchema = z.object({
  amount: z.number(),
  unit: z.enum(['minute', 'hour', 'day', 'week']),
}).strict();

export type RelativeStartOffsetInput = z.infer<typeof relativeStartOffsetInputSchema>;

const normalizeTaskRelativeStartOffset = (value: RelativeStartOffsetInput): RelativeStartOffset => {
  const normalized = normalizeRelativeStartOffset(value);
  if (!normalized || normalized.amount !== value.amount || normalized.unit !== value.unit) {
    throw new ValidationError('Invalid task relativeStartOffset');
  }
  return normalized;
};

export const normalizeOptionalTaskRelativeStartOffset = (
  value: RelativeStartOffsetInput | undefined,
): RelativeStartOffset | undefined => (
  value === undefined ? undefined : normalizeTaskRelativeStartOffset(value)
);

export const normalizeNullableTaskRelativeStartOffset = (
  value: RelativeStartOffsetInput | null | undefined,
): RelativeStartOffset | null | undefined => (
  value === undefined || value === null ? value : normalizeTaskRelativeStartOffset(value)
);

// Checklist items must carry a real id: core's SQLite read codec (toChecklist in
// task-sync-schema.ts) silently drops any item whose id isn't a string, so accepting a
// missing id here would look like a successful write that quietly loses the item on the
// next read/sync round-trip. isCompleted defaults to false (Task['checklist'] items require
// a boolean, not `boolean | undefined`).
const checklistItemInputSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  isCompleted: z.boolean().default(false),
});

export const taskChecklistInputSchema = z.array(checklistItemInputSchema);

// Mirrors normalizeTaskRepeatReminderMinutesValue below (and cloud's
// validateTaskTimeSpentMinutes): 0 always means "no time logged" and needs no round-trip
// check — normalizeTimeSpentMinutes(0) returns undefined (0 is <= 0, "absent"), which would
// otherwise make a perfectly valid `timeSpentMinutes: 0` fail its own round-trip check.
const normalizeTaskTimeSpentMinutesValue = (value: number): number => {
  if (value === 0) return value;
  if (normalizeTimeSpentMinutes(value) !== value) {
    throw new ValidationError('Invalid task timeSpentMinutes');
  }
  return value;
};

export const normalizeOptionalTaskTimeSpentMinutes = (
  value: number | undefined,
): number | undefined => (
  value === undefined ? undefined : normalizeTaskTimeSpentMinutesValue(value)
);

export const normalizeNullableTaskTimeSpentMinutes = (
  value: number | null | undefined,
): number | null | undefined => (
  value === undefined || value === null ? value : normalizeTaskTimeSpentMinutesValue(value)
);

// Mirrors cloud's validateTaskRepeatReminderMinutes: 0 always means "off" and needs no
// preset check; any other value must round-trip through the same presets core applies.
const normalizeTaskRepeatReminderMinutesValue = (value: number): number => {
  if (value === 0) return value;
  if (normalizeRepeatReminderMinutes(value) !== value) {
    throw new ValidationError('Invalid task repeatReminderMinutes');
  }
  return value;
};

export const normalizeOptionalTaskRepeatReminderMinutes = (
  value: number | undefined,
): number | undefined => (
  value === undefined ? undefined : normalizeTaskRepeatReminderMinutesValue(value)
);

export const normalizeNullableTaskRepeatReminderMinutes = (
  value: number | null | undefined,
): number | null | undefined => (
  value === undefined || value === null ? value : normalizeTaskRepeatReminderMinutesValue(value)
);
