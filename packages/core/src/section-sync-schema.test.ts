import { describe, expect, it } from 'vitest';
import {
    SECTION_SQLITE_COLUMNS,
    SECTION_SQLITE_MIGRATION_COLUMNS,
    SECTION_UPSERT_UPDATE_CLAUSE,
} from './sqlite-adapter';
import {
    SECTION_SYNC_FIELD_SCHEMA,
    SECTION_SYNC_SCHEMA_FIXTURE,
    SECTION_SYNC_SCHEMA_VERSION,
} from './section-sync-schema';


const PRE_REFACTOR_SECTION_SQLITE_COLUMNS = [
    'id', 'projectId', 'title', 'description', 'orderNum', 'isCollapsed', 'rev', 'revBy',
    'createdAt', 'updatedAt', 'deletedAt', 'deletedAtBeforeProjectArchive', 'projectArchivedAt', 'isSequential',
];

const PRE_REFACTOR_SECTION_UPSERT_UPDATE_CLAUSE = `projectId=excluded.projectId,
title=excluded.title,
description=excluded.description,
orderNum=excluded.orderNum,
isCollapsed=excluded.isCollapsed,
rev=excluded.rev,
revBy=excluded.revBy,
createdAt=excluded.createdAt,
updatedAt=excluded.updatedAt,
deletedAt=excluded.deletedAt,
deletedAtBeforeProjectArchive=excluded.deletedAtBeforeProjectArchive,
projectArchivedAt=excluded.projectArchivedAt,
isSequential=excluded.isSequential
WHERE sections.rev IS NULL OR sections.rev <= excluded.rev`;

const PRE_REFACTOR_ENSURE_SECTION_COLUMNS_NAMES = [
    'description', 'orderNum', 'isCollapsed', 'rev', 'revBy', 'createdAt', 'updatedAt',
    'deletedAt', 'deletedAtBeforeProjectArchive', 'projectArchivedAt', 'isSequential',
];

const PRE_REFACTOR_ENSURE_SECTION_COLUMNS_SQL = [
    'ALTER TABLE sections ADD COLUMN description TEXT',
    'ALTER TABLE sections ADD COLUMN orderNum INTEGER',
    'ALTER TABLE sections ADD COLUMN isCollapsed INTEGER',
    'ALTER TABLE sections ADD COLUMN rev INTEGER',
    'ALTER TABLE sections ADD COLUMN revBy TEXT',
    'ALTER TABLE sections ADD COLUMN createdAt TEXT',
    'ALTER TABLE sections ADD COLUMN updatedAt TEXT',
    'ALTER TABLE sections ADD COLUMN deletedAt TEXT',
    'ALTER TABLE sections ADD COLUMN deletedAtBeforeProjectArchive TEXT',
    'ALTER TABLE sections ADD COLUMN projectArchivedAt TEXT',
    'ALTER TABLE sections ADD COLUMN isSequential INTEGER',
];

const sorted = (values: Iterable<string>): string[] => Array.from(values).sort();

describe('Section sync schema contract', () => {
    const fieldNames = SECTION_SYNC_FIELD_SCHEMA.map((field) => field.name);

    it('has one unique entry and fixture value for every Section field', () => {
        expect(new Set(fieldNames).size).toBe(fieldNames.length);
        expect(Object.keys(SECTION_SYNC_SCHEMA_FIXTURE).sort()).toEqual(sorted(fieldNames));
        expect(SECTION_SYNC_SCHEMA_VERSION).toBeGreaterThan(0);
    });

    it('keeps SQLite columns exhaustive', () => {
        const expectedColumns = new Set(
            SECTION_SYNC_FIELD_SCHEMA
                .map((field) => field.sqliteColumn)
                .filter((column): column is string => column !== null),
        );
        expect(sorted(SECTION_SQLITE_COLUMNS)).toEqual(sorted(expectedColumns));
    });


    it('derives SECTION_SQLITE_COLUMNS identical to the pre-refactor literal, in order', () => {
        expect(SECTION_SQLITE_COLUMNS).toEqual(PRE_REFACTOR_SECTION_SQLITE_COLUMNS);
    });

    it('derives SECTION_UPSERT_UPDATE_CLAUSE identical to the pre-refactor literal', () => {
        expect(SECTION_UPSERT_UPDATE_CLAUSE).toBe(PRE_REFACTOR_SECTION_UPSERT_UPDATE_CLAUSE);
    });

    it('derives the ensureSectionColumns migration list identical to the pre-refactor literal, in order', () => {
        expect(SECTION_SQLITE_MIGRATION_COLUMNS.map((entry) => entry.name)).toEqual(PRE_REFACTOR_ENSURE_SECTION_COLUMNS_NAMES);
        expect(SECTION_SQLITE_MIGRATION_COLUMNS.map((entry) => entry.sql)).toEqual(PRE_REFACTOR_ENSURE_SECTION_COLUMNS_SQL);
    });
});
