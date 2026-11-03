import schemaFixture from './area-sync-schema.fixture.json';
import type { Area } from './types';
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

export type AreaSyncFieldSpec = {
    name: keyof Area;
    nullability: EntityFieldNullability;
    cloudSynced: boolean;
    cloudWrite: EntityCloudWriteSemantics;
    sqliteColumn: string | null;
    sqliteOrder: number | null;
    sqliteType: EntitySqliteColumnType | null;
};

type AreaSyncSchemaFixture = {
    schemaVersion: number;
    fields: AreaSyncFieldSpec[];
    fixture: Area;
};

const schema = schemaFixture as AreaSyncSchemaFixture;

export const AREA_SYNC_SCHEMA_VERSION = schema.schemaVersion;
export const AREA_SYNC_FIELD_SCHEMA: readonly AreaSyncFieldSpec[] = schema.fields;
export const AREA_SYNC_SCHEMA_FIXTURE: Area = schema.fixture;


const AREA_SQLITE_COLUMN_ENTRIES = deriveSqliteColumnEntries(AREA_SYNC_FIELD_SCHEMA, 'area-sync-schema');

export const AREA_SQLITE_COLUMNS: readonly string[] = sqliteColumnsFromEntries(AREA_SQLITE_COLUMN_ENTRIES);
export const AREA_SQLITE_MIGRATION_COLUMNS = sqliteMigrationColumnsFromEntries(AREA_SQLITE_COLUMN_ENTRIES, 'areas');


const areaColumnValues = (area: Area, nowIso: string): Record<string, unknown> => {
    const createdAt = area.createdAt ?? area.updatedAt ?? nowIso;
    const updatedAt = area.updatedAt ?? area.createdAt ?? nowIso;
    return {
        id: area.id,
        name: area.name,
        color: area.color ?? null,
        icon: area.icon ?? null,
        orderNum: area.order,
        rev: area.rev ?? null,
        revBy: area.revBy ?? null,
        createdAt,
        updatedAt,
        deletedAt: area.deletedAt ?? null,
    };
};

export const areaToSqliteRow = (area: Area, nowIso: string = new Date().toISOString()): unknown[] =>
    sqliteRowFromColumnValues(AREA_SQLITE_COLUMNS, areaColumnValues(area, nowIso));

export const areaFromSqliteRow = (row: Record<string, unknown>, nowIso: string = new Date().toISOString()): Area => {
    const createdAtRaw = typeof row.createdAt === 'string' && row.createdAt.trim().length > 0 ? row.createdAt : undefined;
    const updatedAtRaw = typeof row.updatedAt === 'string' && row.updatedAt.trim().length > 0 ? row.updatedAt : undefined;
    const createdAt = createdAtRaw ?? updatedAtRaw ?? nowIso;
    const updatedAt = updatedAtRaw ?? createdAtRaw ?? nowIso;
    return {
        id: String(row.id),
        name: String(row.name ?? ''),
        color: fromOptional(row.color as string | null),
        icon: fromOptional(row.icon as string | null),
        order: Number(row.orderNum ?? 0),
        rev: row.rev === null || row.rev === undefined ? undefined : Number(row.rev),
        revBy: fromOptional(row.revBy as string | null),
        createdAt,
        updatedAt,
        deletedAt: fromOptional(row.deletedAt as string | null),
    };
};
