import { describe, expect, it } from 'vitest';
import {
    mapSqliteTaskRow,
    TASK_SQLITE_COLUMNS,
    taskToSqliteRow,
} from './sqlite-adapter';
import { normalizeTaskForSyncMerge } from './sync-normalization';
import { mergeAppDataWithStats } from './sync';
import { mockAppData } from './sync-test-utils';
import { shouldSendTaskReminders } from './task-reminder-policy';
import { normalizeTaskForContentComparison, TASK_CONTENT_COMPARISON_EXCLUDED_KEYS } from './sync-signatures';
import {
    TASK_SYNC_FIELD_SCHEMA,
    TASK_SYNC_SCHEMA_FIXTURE,
    TASK_SYNC_SCHEMA_VERSION,
} from './task-sync-schema';
import cloudKitProductionSchema from './cloudkit-production-schema.json';
import type { Task } from './types';

const PRE_REFACTOR_TASK_CONTENT_COMPARISON_EXCLUDED_KEYS = [
    'rev', 'revBy', 'createdAt', 'updatedAt', 'purgedAt', 'order', 'orderNum', 'boardOrder',
    'focusOrder', 'statusBeforeProjectArchive', 'completedAtBeforeProjectArchive',
    'isFocusedTodayBeforeProjectArchive', 'projectArchivedAt',
];

const sorted = (values: Iterable<string>): string[] => Array.from(values).sort();

describe('Task sync schema contract', () => {
    const fieldNames = TASK_SYNC_FIELD_SCHEMA.map((field) => field.name);

    it('has one unique, versioned entry and fixture value for every Task field', () => {
        expect(new Set(fieldNames).size).toBe(fieldNames.length);
        expect(Object.keys(TASK_SYNC_SCHEMA_FIXTURE).sort()).toEqual(sorted(fieldNames));
        expect(TASK_SYNC_SCHEMA_VERSION).toBeGreaterThan(0);
        for (const field of TASK_SYNC_FIELD_SCHEMA) {
            expect(field.sinceVersion).toBeGreaterThan(0);
            expect(field.sinceVersion).toBeLessThanOrEqual(TASK_SYNC_SCHEMA_VERSION);
        }
    });

    it('keeps sync normalization exhaustive', () => {
        const normalized = normalizeTaskForSyncMerge(
            { ...TASK_SYNC_SCHEMA_FIXTURE, purgedAt: undefined },
            '2026-07-14T12:00:00.000Z',
        );

        expect(Object.keys(normalized).sort()).toEqual(sorted(fieldNames));
    });

    it('keeps content-signature fields aligned with their declared semantics', () => {
        const comparable = normalizeTaskForContentComparison(TASK_SYNC_SCHEMA_FIXTURE);
        const expected = TASK_SYNC_FIELD_SCHEMA
            .filter((field) => field.signature === 'content')
            .map((field) => field.name);

        expect(Object.keys(comparable).sort()).toEqual(sorted(expected));
    });

    it('keeps SQLite columns, serialization, and row mapping exhaustive', () => {
        const expectedColumns = new Set(
            TASK_SYNC_FIELD_SCHEMA
                .map((field) => field.sqliteColumn)
                .filter((column): column is string => column !== null),
        );
        expect(sorted(TASK_SQLITE_COLUMNS)).toEqual(sorted(expectedColumns));

        const row = taskToSqliteRow(TASK_SYNC_SCHEMA_FIXTURE);
        expect(row).toHaveLength(TASK_SQLITE_COLUMNS.length);
        const rowRecord = Object.fromEntries(
            TASK_SQLITE_COLUMNS.map((column, index) => [column, row[index]]),
        );
        for (const column of expectedColumns) {
            expect(rowRecord[column], column).not.toBeNull();
            expect(rowRecord[column], column).not.toBeUndefined();
        }

        const mapped = mapSqliteTaskRow(rowRecord);
        expect(Object.keys(mapped).sort()).toEqual(sorted(fieldNames));
    });

    it.each(['inherit', 'send', 'skip', 'start', 'due'] as const)('round-trips %s reminder policy through SQLite and a sync document', (reminderPolicy) => {
        const task = { ...TASK_SYNC_SCHEMA_FIXTURE, deletedAt: undefined, purgedAt: undefined, reminderPolicy };
        const values = taskToSqliteRow(task);
        const row = Object.fromEntries(TASK_SQLITE_COLUMNS.map((column, index) => [column, values[index]]));
        const reloaded = mapSqliteTaskRow(row);
        expect(reloaded.reminderPolicy).toBe(reminderPolicy);
        if (reminderPolicy === 'start' || reminderPolicy === 'due') {
            expect(reloaded.suppressMindwtrReminders).toBe(true);
        }
        const normalized = normalizeTaskForSyncMerge(reloaded, task.updatedAt);
        expect(normalizeTaskForSyncMerge(normalized, task.updatedAt)).toEqual(normalized);
        expect(normalizeTaskForContentComparison(reloaded).reminderPolicy).toBe(reminderPolicy);
        const aligned = mockAppData([reloaded]);
        const first = mergeAppDataWithStats(aligned, JSON.parse(JSON.stringify(aligned)), { nowIso: task.updatedAt });
        expect(first.stats.tasks.conflicts).toBe(0);
        expect(first.data.tasks[0].reminderPolicy).toBe(reminderPolicy);
        const second = mergeAppDataWithStats(first.data, first.data, { nowIso: task.updatedAt });
        expect(second.stats.tasks.conflicts).toBe(0);
        expect(second.data).toEqual(first.data);
    });

    it.each(['start', 'due'] as const)('persists %s with safe legacy suppression even when input has a false flag', (reminderPolicy) => {
        const task = { ...TASK_SYNC_SCHEMA_FIXTURE, deletedAt: undefined, purgedAt: undefined, reminderPolicy, suppressMindwtrReminders: false };
        const values = taskToSqliteRow(task);
        const row = Object.fromEntries(TASK_SQLITE_COLUMNS.map((column, index) => [column, values[index]]));
        expect(row.suppressMindwtrReminders).toBe(1);
        expect(mapSqliteTaskRow(row)).toMatchObject({ reminderPolicy, suppressMindwtrReminders: true });
        const normalized = normalizeTaskForSyncMerge(task, task.updatedAt);
        expect(normalized).toMatchObject({ reminderPolicy, suppressMindwtrReminders: true });
        expect(normalizeTaskForSyncMerge(normalized, task.updatedAt)).toEqual(normalized);
    });

    it.each([true, false])('keeps absent legacy policy explicit after SQLite and older-client sync (skip=%s)', (suppressMindwtrReminders) => {
        const task = { ...TASK_SYNC_SCHEMA_FIXTURE, deletedAt: undefined, purgedAt: undefined, reminderPolicy: undefined, suppressMindwtrReminders };
        const values = taskToSqliteRow(task);
        const row = Object.fromEntries(TASK_SQLITE_COLUMNS.map((column, index) => [column, values[index]]));
        expect(row.reminderPolicy).toBeNull();
        const reloaded = mapSqliteTaskRow(row);
        expect(reloaded.reminderPolicy).toBeUndefined();
        expect(shouldSendTaskReminders(reloaded, { taskReminderDefault: 'skip' })).toBe(!suppressMindwtrReminders);
        const aligned = mockAppData([reloaded]);
        const merged = mergeAppDataWithStats(aligned, JSON.parse(JSON.stringify(aligned)), { nowIso: task.updatedAt });
        expect(merged.stats.tasks.conflicts).toBe(0);
        expect(merged.data.tasks[0].reminderPolicy).toBeUndefined();
        expect(shouldSendTaskReminders(merged.data.tasks[0], { taskReminderDefault: 'skip' })).toBe(!suppressMindwtrReminders);
    });

    it.each(['inherit', 'start', 'due'] as const)('retains newer %s policy when merging with an older client that omits the field', (reminderPolicy) => {
        const current = { ...TASK_SYNC_SCHEMA_FIXTURE, deletedAt: undefined, purgedAt: undefined, reminderPolicy, rev: 2, suppressMindwtrReminders: true };
        const legacy = { ...current, reminderPolicy: undefined, suppressMindwtrReminders: false, rev: 1 };
        const forward = mergeAppDataWithStats(mockAppData([current]), mockAppData([legacy]), { nowIso: current.updatedAt });
        const reverse = mergeAppDataWithStats(mockAppData([legacy]), mockAppData([current]), { nowIso: current.updatedAt });
        expect(forward.data.tasks[0]).toMatchObject({ reminderPolicy, suppressMindwtrReminders: true });
        expect(reverse.data).toEqual(forward.data);
        const second = mergeAppDataWithStats(forward.data, forward.data, { nowIso: current.updatedAt });
        expect(second.stats.tasks.conflicts).toBe(0);
        expect(second.data).toEqual(forward.data);
    });

    it('drops malformed reminder policy without converting old data to inherit', () => {
        const malformed = { ...TASK_SYNC_SCHEMA_FIXTURE, reminderPolicy: 'sometimes' } as unknown as Task;
        const normalized = normalizeTaskForSyncMerge(malformed, malformed.updatedAt);
        expect(normalized.reminderPolicy).toBeUndefined();
        expect(normalizeTaskForContentComparison(malformed).reminderPolicy).toBeUndefined();
        const values = taskToSqliteRow(malformed);
        expect(values[TASK_SQLITE_COLUMNS.indexOf('reminderPolicy')]).toBeNull();
        expect(mapSqliteTaskRow({ id: 'old', title: 'Legacy', status: 'next', reminderPolicy: 'sometimes' }).reminderPolicy).toBeUndefined();
        expect(normalizeTaskForSyncMerge(normalized, malformed.updatedAt)).toEqual(normalized);
    });

    it('records reminderPolicy as deployed to CloudKit production', () => {
        expect(cloudKitProductionSchema.records.MindwtrTask.deployed).toContain('reminderPolicy');
        expect(cloudKitProductionSchema.records.MindwtrTask.pendingProduction).not.toContain('reminderPolicy');
    });

    it('records the new CloudKit task key as deployed to production', () => {
        expect(cloudKitProductionSchema.records.MindwtrTask.deployed)
            .toContain('viewSectionIds');
        expect(cloudKitProductionSchema.records.MindwtrTask.pendingProduction)
            .not.toContain('viewSectionIds');
    });

    it('declares cancellation as an optional content field deployed to CloudKit production', () => {
        const field = TASK_SYNC_FIELD_SCHEMA.find((entry) => entry.name === 'cancelledAt');
        expect(field).toMatchObject({
            nullability: 'optional',
            signature: 'content',
            cloudWrite: 'create-patch',
            sqliteColumn: 'cancelledAt',
            sqliteType: 'TEXT',
        });
        expect(cloudKitProductionSchema.records.MindwtrTask.deployed).toContain('cancelledAt');
        expect(cloudKitProductionSchema.records.MindwtrTask.pendingProduction).not.toContain('cancelledAt');
    });

    it('reads NULL columns as present undefined fields and keeps completedAt only for finished tasks', () => {
        const row = Object.fromEntries(TASK_SQLITE_COLUMNS.map((column) => [column, null]));
        const base = { ...row, id: 't1', title: 'Task', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', completedAt: '2026-01-03T00:00:00.000Z' };
        const open = mapSqliteTaskRow({ ...base, status: 'next' });
        expect(Object.keys(open).sort()).toEqual(sorted(fieldNames));
        expect(open).toStrictEqual({
            ...Object.fromEntries(fieldNames.map((name) => [name, undefined])),
            id: 't1', title: 'Task', status: 'next', tags: [], contexts: [], isFocusedToday: false, suppressMindwtrReminders: false,
            createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
        });
        expect(mapSqliteTaskRow({ ...base, status: ' Done ' })).toMatchObject({ status: 'done', completedAt: '2026-01-03T00:00:00.000Z' });
        expect(mapSqliteTaskRow({ ...base, status: 'archived' }).completedAt).toBe('2026-01-03T00:00:00.000Z');
        expect(mapSqliteTaskRow({ ...base, status: 'waiting' }).completedAt).toBeUndefined();
        expect(mapSqliteTaskRow({ ...base, status: 'next', isFocusedTodayBeforeProjectArchive: 0 }).isFocusedTodayBeforeProjectArchive).toBe(false);
    });

    it('reads NULL project-archive columns as absent so a phone-read task matches the merge winner (#1156)', () => {
        const task: Task = { ...TASK_SYNC_SCHEMA_FIXTURE, completedAtBeforeProjectArchive: undefined, isFocusedTodayBeforeProjectArchive: undefined } as Task;
        const row = taskToSqliteRow(task);
        const record: Record<string, unknown> = {};
        TASK_SQLITE_COLUMNS.forEach((column, index) => { record[column] = row[index]; });
        expect(record.completedAtBeforeProjectArchive).toBeNull();
        expect(record.isFocusedTodayBeforeProjectArchive).toBeNull();
        const readBack = mapSqliteTaskRow(record);
        expect('completedAtBeforeProjectArchive' in readBack && readBack.completedAtBeforeProjectArchive !== undefined).toBe(false);
        expect(readBack.isFocusedTodayBeforeProjectArchive).toBeUndefined();

        const legacy = normalizeTaskForSyncMerge({ ...task, completedAtBeforeProjectArchive: null, isFocusedTodayBeforeProjectArchive: null }, task.updatedAt);
        expect(JSON.stringify(legacy)).toBe(JSON.stringify(normalizeTaskForSyncMerge(task, task.updatedAt)));
        expect(JSON.stringify(legacy)).not.toContain('"completedAtBeforeProjectArchive":null');
    });

    it('keeps the content-comparison excluded-key set aligned with the schema signature field', () => {
        expect(sorted(TASK_CONTENT_COMPARISON_EXCLUDED_KEYS)).toEqual(sorted(PRE_REFACTOR_TASK_CONTENT_COMPARISON_EXCLUDED_KEYS));

        const expectedFromSchema = TASK_SYNC_FIELD_SCHEMA
            .filter((field) => field.signature !== 'content')
            .map((field) => field.name);
        expect(sorted(TASK_CONTENT_COMPARISON_EXCLUDED_KEYS)).toEqual(sorted(expectedFromSchema));
    });
});
