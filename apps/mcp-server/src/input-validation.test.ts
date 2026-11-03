


import { describe, expect, test } from 'bun:test';

import { TASK_RECURRENCE_FIELD_KEYS } from '@mindwtr/core';

import {
  normalizeNullableTaskTimeSpentMinutes,
  normalizeNullableTaskDueReminderLeadMinutes,
  normalizeNullableTaskStartReminderLeadMinutes,
  normalizeOptionalTaskDueReminderLeadMinutes,
  normalizeOptionalTaskStartReminderLeadMinutes,
  normalizeOptionalTaskTimeSpentMinutes,
  TASK_RECURRENCE_INPUT_FIELD_KEYS,
} from './input-validation.js';


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

describe('startReminderLeadMinutes boundary validation', () => {
  test('accepts absent, explicit Off, and bounded integer offsets', () => {
    expect(normalizeOptionalTaskStartReminderLeadMinutes(undefined)).toBeUndefined();
    for (const minutes of [0, 5, 15, 30, 60]) {
      expect(normalizeOptionalTaskStartReminderLeadMinutes(minutes)).toBe(minutes);
    }
    expect(normalizeNullableTaskStartReminderLeadMinutes(null)).toBe(null);
  });
  test('rejects fractional, negative, and excessive offsets', () => {
    for (const minutes of [-1, 1, 1.5, 61, NaN, Infinity]) {
      expect(() => normalizeOptionalTaskStartReminderLeadMinutes(minutes)).toThrow('Invalid task startReminderLeadMinutes');
    }
  });
});
