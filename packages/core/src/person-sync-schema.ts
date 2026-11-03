import schemaFixture from './person-sync-schema.fixture.json';
import type { Person } from './types';
import {
    deriveSqliteColumnEntries,
    fromOptional,
    sqliteColumnsFromEntries,
    sqliteMigrationColumnsFromEntries,
    sqliteRowFromColumnValues,
    type EntityCloudWriteSemantics,
    type EntityFieldNullability,
    type EntitySqliteColumnType,
} from './entity-sync-schema';

export type PersonSyncFieldSpec = {
    name: keyof Person;
    nullability: EntityFieldNullability;
    cloudSynced: boolean;
    cloudWrite: EntityCloudWriteSemantics;
    sqliteColumn: string | null;
    sqliteOrder: number | null;
    sqliteType: EntitySqliteColumnType | null;
};

type PersonSyncSchemaFixture = {
    schemaVersion: number;
    fields: PersonSyncFieldSpec[];
    fixture: Person;
};

const schema = schemaFixture as PersonSyncSchemaFixture;

export const PERSON_SYNC_SCHEMA_VERSION = schema.schemaVersion;
export const PERSON_SYNC_FIELD_SCHEMA: readonly PersonSyncFieldSpec[] = schema.fields;
export const PERSON_SYNC_SCHEMA_FIXTURE: Person = schema.fixture;


const PERSON_SQLITE_COLUMN_ENTRIES = deriveSqliteColumnEntries(PERSON_SYNC_FIELD_SCHEMA, 'person-sync-schema');

export const PERSON_SQLITE_COLUMNS: readonly string[] = sqliteColumnsFromEntries(PERSON_SQLITE_COLUMN_ENTRIES);
export const PERSON_SQLITE_MIGRATION_COLUMNS = sqliteMigrationColumnsFromEntries(PERSON_SQLITE_COLUMN_ENTRIES, 'people');


const personColumnValues = (person: Person, nowIso: string): Record<string, unknown> => {
    const createdAt = person.createdAt ?? person.updatedAt ?? nowIso;
    const updatedAt = person.updatedAt ?? person.createdAt ?? nowIso;
    return {
        id: person.id,
        name: person.name,
        note: person.note ?? null,
        referenceLink: person.referenceLink ?? null,
        rev: person.rev ?? null,
        revBy: person.revBy ?? null,
        createdAt,
        updatedAt,
        deletedAt: person.deletedAt ?? null,
    };
};

export const personToSqliteRow = (person: Person, nowIso: string = new Date().toISOString()): unknown[] =>
    sqliteRowFromColumnValues(PERSON_SQLITE_COLUMNS, personColumnValues(person, nowIso));

export const personFromSqliteRow = (row: Record<string, unknown>, nowIso: string = new Date().toISOString()): Person => {
    const createdAtRaw = typeof row.createdAt === 'string' && row.createdAt.trim().length > 0 ? row.createdAt : undefined;
    const updatedAtRaw = typeof row.updatedAt === 'string' && row.updatedAt.trim().length > 0 ? row.updatedAt : undefined;
    const createdAt = createdAtRaw ?? updatedAtRaw ?? nowIso;
    const updatedAt = updatedAtRaw ?? createdAtRaw ?? nowIso;
    return {
        id: String(row.id),
        name: String(row.name ?? ''),
        note: fromOptional(row.note as string | null),
        referenceLink: fromOptional(row.referenceLink as string | null),
        rev: row.rev === null || row.rev === undefined ? undefined : Number(row.rev),
        revBy: fromOptional(row.revBy as string | null),
        createdAt,
        updatedAt,
        deletedAt: fromOptional(row.deletedAt as string | null),
    };
};
