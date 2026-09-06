import schemaFixture from './section-sync-schema.fixture.json';
import type { Section } from './types';
import {
    deriveSqliteColumnEntries,
    fromBool,
    fromOptional,
    sqliteColumnsFromEntries,
    sqliteMigrationColumnsFromEntries,
    sqliteRowFromColumnValues,
    toBool,
    type EntityCloudWriteSemantics,
    type EntityFieldNullability,
    type EntitySqliteColumnType,
} from './entity-sync-schema';

export type SectionSyncFieldSpec = {
    name: keyof Section;
    nullability: EntityFieldNullability;
    cloudSynced: boolean;
    cloudWrite: EntityCloudWriteSemantics;
    sqliteColumn: string | null;
    sqliteOrder: number | null;
    sqliteType: EntitySqliteColumnType | null;
};

type SectionSyncSchemaFixture = {
    schemaVersion: number;
    fields: SectionSyncFieldSpec[];
    fixture: Section;
};

const schema = schemaFixture as SectionSyncSchemaFixture;

export const SECTION_SYNC_SCHEMA_VERSION = schema.schemaVersion;
export const SECTION_SYNC_FIELD_SCHEMA: readonly SectionSyncFieldSpec[] = schema.fields;
export const SECTION_SYNC_SCHEMA_FIXTURE: Section = schema.fixture;

// Generated SQLite column list + ensureSectionColumns migration list — see the equivalent
// comment in project-sync-schema.ts for why this lives here rather than sqlite-adapter.ts.
const SECTION_SQLITE_COLUMN_ENTRIES = deriveSqliteColumnEntries(SECTION_SYNC_FIELD_SCHEMA, 'section-sync-schema');

export const SECTION_SQLITE_COLUMNS: readonly string[] = sqliteColumnsFromEntries(SECTION_SQLITE_COLUMN_ENTRIES);
export const SECTION_SQLITE_MIGRATION_COLUMNS = sqliteMigrationColumnsFromEntries(SECTION_SQLITE_COLUMN_ENTRIES, 'sections');

// Row codec pair — see the equivalent comment in project-sync-schema.ts. Replaces the
// hand-written positional literal in saveData() and the private mapSectionRow class method.
const sectionColumnValues = (section: Section): Record<string, unknown> => ({
    id: section.id,
    projectId: section.projectId,
    title: section.title,
    description: section.description ?? null,
    orderNum: Number.isFinite(section.order) ? section.order : 0,
    isCollapsed: toBool(section.isCollapsed),
    rev: section.rev ?? null,
    revBy: section.revBy ?? null,
    createdAt: section.createdAt,
    updatedAt: section.updatedAt,
    deletedAt: section.deletedAt ?? null,
    deletedAtBeforeProjectArchive: section.deletedAtBeforeProjectArchive ?? null,
    projectArchivedAt: section.projectArchivedAt ?? null,
});

export const sectionToSqliteRow = (section: Section): unknown[] =>
    sqliteRowFromColumnValues(SECTION_SQLITE_COLUMNS, sectionColumnValues(section));

// `_rowid` fallback matches project's — see the comment in project-sync-schema.ts.
export const sectionFromSqliteRow = (row: Record<string, unknown>): Section => {
    const orderNumRaw = row.orderNum;
    const fallbackOrder = typeof row._rowid === 'number' ? row._rowid : 0;
    return {
        id: String(row.id),
        projectId: String(row.projectId ?? ''),
        title: String(row.title ?? ''),
        description: fromOptional(row.description as string | null),
        order: orderNumRaw === null || orderNumRaw === undefined ? fallbackOrder : Number(orderNumRaw),
        isCollapsed: fromBool(row.isCollapsed),
        rev: row.rev === null || row.rev === undefined ? undefined : Number(row.rev),
        revBy: fromOptional(row.revBy as string | null),
        createdAt: String(row.createdAt ?? ''),
        updatedAt: String(row.updatedAt ?? ''),
        deletedAt: fromOptional(row.deletedAt as string | null),
        // NULL reads as absent (see the task codec's project-archive fields, #1156).
        deletedAtBeforeProjectArchive: fromOptional(row.deletedAtBeforeProjectArchive as string | null),
        projectArchivedAt: fromOptional(row.projectArchivedAt as string | null),
    };
};
