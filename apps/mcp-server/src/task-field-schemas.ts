


import * as z from 'zod';

import type { Task } from './queries.js';
import {
  isoDateLikeSchema,
  relativeStartOffsetInputSchema,
  taskChecklistInputSchema,
} from './input-validation.js';
import { TASK_CREATE_FIELD_NAMES, TASK_PATCH_FIELD_NAMES } from './task-write-fields.js';
import { viewSectionIdsSchema } from './view-sections.js';


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
  dueReminderLeadMinutes: z.number().int().min(0).max(10080).describe('Minutes before an explicit due time; 0 = off, maximum one week'),
  startReminderLeadMinutes: z.union([z.literal(0), z.literal(5), z.literal(15), z.literal(30), z.literal(60)]).describe('Minutes before an explicit start time; 0 = off, maximum one hour'),
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


const BOOLEAN_FIELD_NAMES = new Set<keyof Task>(['showFutureRecurrence', 'isFocusedToday', 'suppressMindwtrReminders']);


export const nullableOptional = <T extends z.ZodTypeAny>(schema: T) => {
  const wrapped = schema.nullable().optional();
  return schema.description ? wrapped.describe(schema.description) : wrapped;
};


export const buildTaskCreateFieldsShape = (): Record<string, z.ZodTypeAny> => {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const name of TASK_CREATE_FIELD_NAMES) {
    shape[name] = fieldSchemaFor(name).optional();
  }
  return shape;
};


export const buildTaskUpdateFieldsShape = (): Record<string, z.ZodTypeAny> => {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const name of TASK_PATCH_FIELD_NAMES) {

    shape[name] = BOOLEAN_FIELD_NAMES.has(name) || name === 'reminderPolicy'
      ? fieldSchemaFor(name).optional()
      : nullableOptional(fieldSchemaFor(name));
  }
  return shape;
};
