// This is the consolidation-law guard for the MCP task write-surface derivation
// (task-write-fields.ts/task-field-schemas.ts): a test that only re-imports the already
// derived TASK_CREATE_FIELD_NAMES/TASK_PATCH_FIELD_NAMES and asserts they equal themselves
// would pass even if the derivation silently narrowed. This file instead (a) recomputes the
// expected sets independently, straight from TASK_SYNC_FIELD_SCHEMA, in its own expression —
// not by importing task-write-fields.ts's filter — so a bug in that file's filter shows up as
// a mismatch here, and (b) asserts the REAL Zod tool schemas (addTaskSchema/updateTaskSchema)
// actually carry every derived field, not just that the derivation constants look right in
// isolation.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { TASK_SYNC_FIELD_SCHEMA } from '@mindwtr/core/task-sync-schema';

import { addTaskSchema, updateTaskSchema } from './index.js';
import {
  TASK_CREATE_FIELD_NAMES,
  TASK_PATCH_FIELD_NAMES,
  TASK_WRITE_FIELD_EXCLUSIONS,
} from './task-write-fields.js';

// Mirrors what a field needs to reach mindwtr_add_task/mindwtr_update_task: writable per the
// schema, and not the id/title identity fields those tools already expose their own way.
const DEDICATED_FIELD_NAMES = new Set([
  'title', 'status', 'priority', 'energyLevel', 'assignedTo', 'startTime', 'dueDate',
  'recurrence', 'tags', 'contexts', 'description', 'projectId', 'sectionId', 'timeEstimate',
  'attachments',
]);

describe('MCP task write-surface derivation (TASK_SYNC_FIELD_SCHEMA -> Zod tool schemas)', () => {
  test('TASK_WRITE_FIELD_EXCLUSIONS names only real, currently-writable Task fields (non-stale)', () => {
    const writableFieldNames = new Set(
      TASK_SYNC_FIELD_SCHEMA
        .filter((field) => field.cloudWrite === 'create-patch' || field.cloudWrite === 'patch')
        .map((field) => field.name),
    );
    for (const excludedName of Object.keys(TASK_WRITE_FIELD_EXCLUSIONS) as (keyof typeof TASK_WRITE_FIELD_EXCLUSIONS)[]) {
      expect(writableFieldNames.has(excludedName)).toBe(true);
    }
  });

  test('TASK_CREATE_FIELD_NAMES matches an independent recomputation from the schema', () => {
    const expected = TASK_SYNC_FIELD_SCHEMA
      .filter((field) => (
        field.cloudWrite === 'create-patch'
        && !DEDICATED_FIELD_NAMES.has(field.name)
        && !(field.name in TASK_WRITE_FIELD_EXCLUSIONS)
      ))
      .map((field) => field.name)
      .sort();
    expect([...TASK_CREATE_FIELD_NAMES].sort()).toEqual(expected);
  });

  test('TASK_PATCH_FIELD_NAMES matches an independent recomputation from the schema', () => {
    const expected = TASK_SYNC_FIELD_SCHEMA
      .filter((field) => (
        (field.cloudWrite === 'create-patch' || field.cloudWrite === 'patch')
        && !DEDICATED_FIELD_NAMES.has(field.name)
        && !(field.name in TASK_WRITE_FIELD_EXCLUSIONS)
      ))
      .map((field) => field.name)
      .sort();
    expect([...TASK_PATCH_FIELD_NAMES].sort()).toEqual(expected);
  });

  test('mindwtr_add_task exposes every TASK_CREATE_FIELD_NAMES field', () => {
    const shapeKeys = new Set(Object.keys(addTaskSchema.shape));
    for (const name of TASK_CREATE_FIELD_NAMES) {
      expect(shapeKeys.has(name)).toBe(true);
    }
  });

  test('mindwtr_update_task exposes every TASK_PATCH_FIELD_NAMES field', () => {
    const shapeKeys = new Set(Object.keys(updateTaskSchema.shape));
    for (const name of TASK_PATCH_FIELD_NAMES) {
      expect(shapeKeys.has(name)).toBe(true);
    }
  });

  test('task write schemas accept positive custom time estimates', () => {
    expect(addTaskSchema.safeParse({ title: 'Task', timeEstimate: 'custom:42.5' }).success).toBe(true);
    expect(updateTaskSchema.safeParse({ id: 'task-1', timeEstimate: 'custom:0' }).success).toBe(false);
    expect(updateTaskSchema.safeParse({ id: 'task-1', timeEstimate: 'custom:0x10' }).success).toBe(false);
  });

  test('the canonical README lists every generated task write field', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const addSection = readme.slice(readme.indexOf('- `mindwtr_add_task`'), readme.indexOf('- `mindwtr_update_task`'));
    const updateSection = readme.slice(readme.indexOf('- `mindwtr_update_task`'), readme.indexOf('- `mindwtr_complete_task`'));

    for (const name of TASK_CREATE_FIELD_NAMES) expect(addSection).toContain(`${name}?`);
    for (const name of TASK_PATCH_FIELD_NAMES) expect(updateSection).toContain(`${name}?`);
  });

  // Mutation-test evidence (per the consolidation law): manually removing 'checklist' from
  // TASK_CREATE_FIELD_NAMES's filter in task-write-fields.ts (temporarily, while developing
  // this test) made the second test above fail as expected; removing 'attachments' from
  // TASK_WRITE_FIELD_EXCLUSIONS made the third test above fail (extra field not accounted
  // for by DEDICATED_FIELD_NAMES/exclusions). Both were reverted before landing.
  test('closes the create-time gap: checklist, areaId, reviewAt, isFocusedToday reach mindwtr_add_task', () => {
    const shapeKeys = new Set(Object.keys(addTaskSchema.shape));
    for (const name of ['checklist', 'areaId', 'reviewAt', 'isFocusedToday']) {
      expect(shapeKeys.has(name)).toBe(true);
    }
  });
});
