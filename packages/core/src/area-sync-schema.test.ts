import { describe, expect, it } from 'vitest';
import {
    AREA_SQLITE_COLUMNS,
    AREA_SQLITE_MIGRATION_COLUMNS,
    AREA_UPSERT_UPDATE_CLAUSE,
} from './sqlite-adapter';
import {
    AREA_SYNC_FIELD_SCHEMA,
    AREA_SYNC_SCHEMA_FIXTURE,
    AREA_SYNC_SCHEMA_VERSION,
} from './area-sync-schema';


const PRE_REFACTOR_AREA_SQLITE_COLUMNS = [
    'id', 'name', 'color', 'icon', 'orderNum', 'rev', 'revBy', 'createdAt', 'updatedAt', 'deletedAt',
];

const PRE_REFACTOR_AREA_UPSERT_UPDATE_CLAUSE = `name=excluded.name,
color=excluded.color,
icon=excluded.icon,
orderNum=excluded.orderNum,
rev=excluded.rev,
revBy=excluded.revBy,
createdAt=excluded.createdAt,
updatedAt=excluded.updatedAt,
deletedAt=excluded.deletedAt
WHERE areas.rev IS NULL OR areas.rev <= excluded.rev`;

const PRE_REFACTOR_ENSURE_AREA_COLUMNS_NAMES = [
    'color', 'icon', 'orderNum', 'rev', 'revBy', 'createdAt', 'updatedAt', 'deletedAt',
];

const PRE_REFACTOR_ENSURE_AREA_COLUMNS_SQL = [
    'ALTER TABLE areas ADD COLUMN color TEXT',
    'ALTER TABLE areas ADD COLUMN icon TEXT',
    'ALTER TABLE areas ADD COLUMN orderNum INTEGER',
    'ALTER TABLE areas ADD COLUMN rev INTEGER',
    'ALTER TABLE areas ADD COLUMN revBy TEXT',
    'ALTER TABLE areas ADD COLUMN createdAt TEXT',
    'ALTER TABLE areas ADD COLUMN updatedAt TEXT',
    'ALTER TABLE areas ADD COLUMN deletedAt TEXT',
];

const sorted = (values: Iterable<string>): string[] => Array.from(values).sort();

describe('Area sync schema contract', () => {
    const fieldNames = AREA_SYNC_FIELD_SCHEMA.map((field) => field.name);

    it('has one unique entry and fixture value for every Area field', () => {
        expect(new Set(fieldNames).size).toBe(fieldNames.length);
        expect(Object.keys(AREA_SYNC_SCHEMA_FIXTURE).sort()).toEqual(sorted(fieldNames));
        expect(AREA_SYNC_SCHEMA_VERSION).toBeGreaterThan(0);
    });

    it('keeps SQLite columns exhaustive', () => {
        const expectedColumns = new Set(
            AREA_SYNC_FIELD_SCHEMA
                .map((field) => field.sqliteColumn)
                .filter((column): column is string => column !== null),
        );
        expect(sorted(AREA_SQLITE_COLUMNS)).toEqual(sorted(expectedColumns));
    });


    it('derives AREA_SQLITE_COLUMNS identical to the pre-refactor literal, in order', () => {
        expect(AREA_SQLITE_COLUMNS).toEqual(PRE_REFACTOR_AREA_SQLITE_COLUMNS);
    });

    it('derives AREA_UPSERT_UPDATE_CLAUSE identical to the pre-refactor literal', () => {
        expect(AREA_UPSERT_UPDATE_CLAUSE).toBe(PRE_REFACTOR_AREA_UPSERT_UPDATE_CLAUSE);
    });

    it('derives the ensureAreaColumns migration list identical to the pre-refactor literal, in order', () => {
        expect(AREA_SQLITE_MIGRATION_COLUMNS.map((entry) => entry.name)).toEqual(PRE_REFACTOR_ENSURE_AREA_COLUMNS_NAMES);
        expect(AREA_SQLITE_MIGRATION_COLUMNS.map((entry) => entry.sql)).toEqual(PRE_REFACTOR_ENSURE_AREA_COLUMNS_SQL);
    });
});
