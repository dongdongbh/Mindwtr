// Builds the Zod object shapes for mindwtr_add_task/mindwtr_update_task's generic per-field
// inputs from TASK_CREATE_FIELD_NAMES/TASK_PATCH_FIELD_NAMES (task-write-fields.ts), which are
// themselves derived from TASK_SYNC_FIELD_SCHEMA. Adding a field to that descriptor with
// cloudWrite 'create-patch'/'patch' means adding ONE entry to TASK_FIELD_ZOD_SCHEMAS below —
// everything else (which tool exposes it, nullable-on-update wrapping) follows automatically.
//
// This file needs `zod`, so — unlike task-write-fields.ts — it must NOT be imported by
// scripts/check-synced-field-parity.ts (that script's "native-schema" CI job runs without
// `bun install`, so `zod` wouldn't resolve there).
import * as z from 'zod';

import type { Task } from './queries.js';
import {
  isoDateLikeSchema,
  relativeStartOffsetInputSchema,
  taskChecklistInputSchema,
} from './input-validation.js';
import { TASK_CREATE_FIELD_NAMES, TASK_PATCH_FIELD_NAMES } from './task-write-fields.js';
import { viewSectionIdsSchema } from './view-sections.js';

// Per-field structural (shape-only) Zod type for every generated task field. Semantic
// validation beyond shape (recurrence compatibility, relativeStartOffset/timeSpentMinutes/
// repeatReminderMinutes round-tripping through core's normalizers) happens separately in
// input-validation.ts's normalize* helpers, applied in index.ts's normalizeAddTaskInput/
// normalizeUpdateTaskInput — mirroring how the existing hand-written recurrence field works.
const TASK_FIELD_ZOD_SCHEMAS: Partial<Record<keyof Task, z.ZodTypeAny>> = {
  viewSectionIds: viewSectionIdsSchema,
  cancelledAt: z.string().datetime({ offset: true }).describe('Cancellation time in ISO format; archives the task without completion or another recurrence'),
  taskMode: z.enum(['task', 'list']).describe('Task mode: task or list (checklist-first)'),
  relativeStartOffset: relativeStartOffsetInputSchema.describe(
    'Offset from dueDate that recomputes startTime when dueDate changes'
  ),
  showFutureRecurrence: z.boolean().describe('Calendar-only preview of the next recurrence'),
  pushCount: z.number().int().nonnegative().describe('How many times dueDate has been pushed later'),
  checklist: taskChecklistInputSchema.describe('Checklist/subtask items'),
  textDirection: z.enum(['auto', 'ltr', 'rtl']).describe('Text direction for title/description'),
  location: z.string().describe('Free-text location'),
  areaId: z.string().describe('Area ID (only used when the task has no projectId)'),
  isFocusedToday: z.boolean().describe("Marked as today's focus list"),
  timeSpentMinutes: z.number().int().nonnegative().describe('Total minutes worked on the task'),
  suppressMindwtrReminders: z.boolean().describe('Skip Mindwtr start/due reminders for this task'),
  reminderPolicy: z.enum(['inherit', 'send', 'skip']).describe('Inherit the global task reminder default, explicitly send, or skip start/due reminders'),
  repeatReminderMinutes: z.number().int().nonnegative().describe(
    'Repeat the due-time reminder every N minutes (presets 5|10|15|30|60); 0/absent = off'
  ),
  reviewAt: isoDateLikeSchema.describe('Tickler/review date in ISO format'),
  order: z.number().int().describe('Manual ordering within a sequential project'),
  boardOrder: z.number().int().describe('Manual ordering within a Board status column'),
  focusOrder: z.number().int().describe("Manual ordering within Today's Focus"),
};

const fieldSchemaFor = (name: keyof Task): z.ZodTypeAny => {
  const schema = TASK_FIELD_ZOD_SCHEMAS[name];
  if (!schema) {
    throw new Error(`task-field-schemas: no Zod schema mapped for generated task field "${name}"`);
  }
  return schema;
};

// Booleans have no "clear it" state distinct from false, so — unlike every other generated
// field — they stay plain `.optional()` on update rather than `.nullable().optional()`
// (matches the pre-existing hand-written `isFocusedToday: z.boolean().optional()`).
const BOOLEAN_FIELD_NAMES = new Set<keyof Task>(['showFutureRecurrence', 'isFocusedToday', 'suppressMindwtrReminders']);

/** Shape for mindwtr_add_task's generated fields (merge into the tool's z.object alongside title/quickAdd). */
export const buildTaskCreateFieldsShape = (): Record<string, z.ZodTypeAny> => {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const name of TASK_CREATE_FIELD_NAMES) {
    shape[name] = fieldSchemaFor(name).optional();
  }
  return shape;
};

/** Shape for mindwtr_update_task's generated fields (merge into the tool's z.object alongside id/title). */
export const buildTaskUpdateFieldsShape = (): Record<string, z.ZodTypeAny> => {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const name of TASK_PATCH_FIELD_NAMES) {
    // Inheritance is explicit; null must not silently discard a reminder choice.
    shape[name] = BOOLEAN_FIELD_NAMES.has(name) || name === 'reminderPolicy'
      ? fieldSchemaFor(name).optional()
      : fieldSchemaFor(name).nullable().optional();
  }
  return shape;
};
