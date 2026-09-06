import { describe, expect, it } from 'vitest';
import {
    mapSqliteTaskRow,
    TASK_SQLITE_COLUMNS,
    taskToSqliteRow,
} from './sqlite-adapter';
import { normalizeTaskForSyncMerge } from './sync-normalization';
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

    it('records the new CloudKit task key as deployed to production', () => {
        expect(cloudKitProductionSchema.records.MindwtrTask.deployed)
            .toContain('viewSectionIds');
        expect(cloudKitProductionSchema.records.MindwtrTask.pendingProduction)
            .not.toContain('viewSectionIds');
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
