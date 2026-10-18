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

    it.each(['inherit', 'send', 'skip'] as const)('round-trips %s reminder policy through SQLite and a sync document', (reminderPolicy) => {
        const task = { ...TASK_SYNC_SCHEMA_FIXTURE, deletedAt: undefined, purgedAt: undefined, reminderPolicy };
        const values = taskToSqliteRow(task);
        const row = Object.fromEntries(TASK_SQLITE_COLUMNS.map((column, index) => [column, values[index]]));
        const reloaded = mapSqliteTaskRow(row);
        expect(reloaded.reminderPolicy).toBe(reminderPolicy);
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

    it('retains a newer policy when merging with an older client that omits the field', () => {
        const current = { ...TASK_SYNC_SCHEMA_FIXTURE, deletedAt: undefined, purgedAt: undefined, reminderPolicy: 'inherit' as const, rev: 2 };
        const legacy = { ...current, reminderPolicy: undefined, rev: 1 };
        const forward = mergeAppDataWithStats(mockAppData([current]), mockAppData([legacy]), { nowIso: current.updatedAt });
        const reverse = mergeAppDataWithStats(mockAppData([legacy]), mockAppData([current]), { nowIso: current.updatedAt });
        expect(forward.data.tasks[0].reminderPolicy).toBe('inherit');
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

    it('records reminderPolicy as requiring CloudKit production deployment', () => {
        expect(cloudKitProductionSchema.records.MindwtrTask.pendingProduction).toContain('reminderPolicy');
        expect(cloudKitProductionSchema.records.MindwtrTask.deployed).not.toContain('reminderPolicy');
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
        // A document an older client uploaded with explicit nulls converges to the same bytes.
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
