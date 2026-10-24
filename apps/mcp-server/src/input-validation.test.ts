// Consolidation-law guard: TASK_RECURRENCE_INPUT_FIELD_KEYS (the key set of
// recurrenceObjectSchema, the zod object mindwtr_add_task/mindwtr_update_task's recurrence
// input actually validates against) must still equal the 14-key list
// packages/core/src/task-recurrence-fields.ts now shares with
// apps/cloud/src/server-validation.ts's CLOUD_RECURRENCE_ALLOWED_KEYS (the same list, verbatim
// — see that file). The literal below stays PINNED on purpose (consolidation law: a test
// importing the same shared list on both sides would shrink in lockstep with it); the
// second assertion ties the shared core list to the same pin.
import { describe, expect, test } from 'bun:test';

import { TASK_RECURRENCE_FIELD_KEYS } from '@mindwtr/core';

import {
  normalizeNullableTaskTimeSpentMinutes,
  normalizeNullableTaskDueReminderLeadMinutes,
  normalizeOptionalTaskDueReminderLeadMinutes,
  normalizeOptionalTaskTimeSpentMinutes,
  TASK_RECURRENCE_INPUT_FIELD_KEYS,
} from './input-validation.js';

// Mutation-test evidence: temporarily dropping 'rrule' from
// input-validation.ts's recurrenceObjectSchema while developing this test made the assertion
// below fail as expected; reverted before landing.
const PINNED_RECURRENCE_FIELD_KEYS = [
  'rule', 'seriesId', 'strategy', 'byDay', 'byMonthDay', 'weekStart', 'count', 'until',
  'completedOccurrences', 'anchorDay', 'startAnchorDay', 'dueAnchorDay', 'reviewAnchorDay',
  'rrule', 'preserveChecklistOnRepeat',
];

describe('recurrence field-key consolidation (single shared list, two consumers)', () => {
  test("mindwtr_add_task/mindwtr_update_task's recurrence object schema exposes exactly the shared recurrence field set", () => {
    expect([...TASK_RECURRENCE_INPUT_FIELD_KEYS].sort()).toEqual([...PINNED_RECURRENCE_FIELD_KEYS].sort());
  });

  test("core's shared TASK_RECURRENCE_FIELD_KEYS matches the same pinned list", () => {
    expect([...TASK_RECURRENCE_FIELD_KEYS].sort()).toEqual([...PINNED_RECURRENCE_FIELD_KEYS].sort());
  });
});

// normalizeTimeSpentMinutes(0) (core) returns undefined -- 0 rounds to "absent" -- so the
// round-trip check `normalizeTimeSpentMinutes(value) !== value` used to fail for the one value
// (0) that should always be allowed and just clears the field, exactly like
// repeatReminderMinutes's own 0 shortcut already did.
describe('timeSpentMinutes: 0 is a valid "no time logged" value, not a validation error', () => {
  test('create: 0 passes through unchanged', () => {
    expect(normalizeOptionalTaskTimeSpentMinutes(0)).toBe(0);
  });

  test('update: 0 passes through unchanged (clears the field)', () => {
    expect(normalizeNullableTaskTimeSpentMinutes(0)).toBe(0);
  });

  test('update: null still clears the field', () => {
    expect(normalizeNullableTaskTimeSpentMinutes(null)).toBe(null);
  });

  test('a genuinely invalid non-zero value still throws', () => {
    expect(() => normalizeOptionalTaskTimeSpentMinutes(-5)).toThrow('Invalid task timeSpentMinutes');
  });
});


describe('dueReminderLeadMinutes boundary validation', () => {
  test('accepts absent, explicit Off, and bounded integer offsets', () => {
    expect(normalizeOptionalTaskDueReminderLeadMinutes(undefined)).toBeUndefined();
    for (const minutes of [0, 1, 15, 1440, 10080]) {
      expect(normalizeOptionalTaskDueReminderLeadMinutes(minutes)).toBe(minutes);
    }
    expect(normalizeNullableTaskDueReminderLeadMinutes(null)).toBe(null);
  });
  test('rejects fractional, negative, and excessive offsets', () => {
    for (const minutes of [-1, 1.5, 10081, NaN, Infinity]) {
      expect(() => normalizeOptionalTaskDueReminderLeadMinutes(minutes)).toThrow('Invalid task dueReminderLeadMinutes');
    }
  });
});
