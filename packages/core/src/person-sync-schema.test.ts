import { describe, expect, it } from 'vitest';
import {
    PERSON_SQLITE_COLUMNS,
    PERSON_SQLITE_MIGRATION_COLUMNS,
    PERSON_UPSERT_UPDATE_CLAUSE,
} from './sqlite-adapter';
import {
    PERSON_SYNC_FIELD_SCHEMA,
    PERSON_SYNC_SCHEMA_FIXTURE,
    PERSON_SYNC_SCHEMA_VERSION,
} from './person-sync-schema';


const PRE_REFACTOR_PERSON_SQLITE_COLUMNS = [
    'id', 'name', 'note', 'referenceLink', 'rev', 'revBy', 'createdAt', 'updatedAt', 'deletedAt',
];

const PRE_REFACTOR_PERSON_UPSERT_UPDATE_CLAUSE = `name=excluded.name,
note=excluded.note,
referenceLink=excluded.referenceLink,
rev=excluded.rev,
revBy=excluded.revBy,
createdAt=excluded.createdAt,
updatedAt=excluded.updatedAt,
deletedAt=excluded.deletedAt
WHERE people.rev IS NULL OR people.rev <= excluded.rev`;

const PRE_REFACTOR_ENSURE_PERSON_COLUMNS_NAMES = [
    'note', 'referenceLink', 'rev', 'revBy', 'createdAt', 'updatedAt', 'deletedAt',
];

const PRE_REFACTOR_ENSURE_PERSON_COLUMNS_SQL = [
    'ALTER TABLE people ADD COLUMN note TEXT',
    'ALTER TABLE people ADD COLUMN referenceLink TEXT',
    'ALTER TABLE people ADD COLUMN rev INTEGER',
    'ALTER TABLE people ADD COLUMN revBy TEXT',
    'ALTER TABLE people ADD COLUMN createdAt TEXT',
    'ALTER TABLE people ADD COLUMN updatedAt TEXT',
    'ALTER TABLE people ADD COLUMN deletedAt TEXT',
];

const sorted = (values: Iterable<string>): string[] => Array.from(values).sort();

describe('Person sync schema contract', () => {
    const fieldNames = PERSON_SYNC_FIELD_SCHEMA.map((field) => field.name);

    it('has one unique entry and fixture value for every Person field', () => {
        expect(new Set(fieldNames).size).toBe(fieldNames.length);
        expect(Object.keys(PERSON_SYNC_SCHEMA_FIXTURE).sort()).toEqual(sorted(fieldNames));
        expect(PERSON_SYNC_SCHEMA_VERSION).toBeGreaterThan(0);
    });

    it('keeps SQLite columns exhaustive', () => {
        const expectedColumns = new Set(
            PERSON_SYNC_FIELD_SCHEMA
                .map((field) => field.sqliteColumn)
                .filter((column): column is string => column !== null),
        );
        expect(sorted(PERSON_SQLITE_COLUMNS)).toEqual(sorted(expectedColumns));
    });


    it('derives PERSON_SQLITE_COLUMNS identical to the pre-refactor literal, in order', () => {
        expect(PERSON_SQLITE_COLUMNS).toEqual(PRE_REFACTOR_PERSON_SQLITE_COLUMNS);
    });

    it('derives PERSON_UPSERT_UPDATE_CLAUSE identical to the pre-refactor literal', () => {
        expect(PERSON_UPSERT_UPDATE_CLAUSE).toBe(PRE_REFACTOR_PERSON_UPSERT_UPDATE_CLAUSE);
    });

    it('derives the ensurePeopleTable migration list identical to the pre-refactor literal, in order', () => {
        expect(PERSON_SQLITE_MIGRATION_COLUMNS.map((entry) => entry.name)).toEqual(PRE_REFACTOR_ENSURE_PERSON_COLUMNS_NAMES);
        expect(PERSON_SQLITE_MIGRATION_COLUMNS.map((entry) => entry.sql)).toEqual(PRE_REFACTOR_ENSURE_PERSON_COLUMNS_SQL);
    });
});
