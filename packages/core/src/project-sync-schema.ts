import { normalizeProjectCalendarReference } from './project-calendar-reference-schema';
import schemaFixture from './project-sync-schema.fixture.json';
import type { Project } from './types';
import { normalizeProjectSequentialScope, normalizeProjectTaskSortBy } from './project-utils';
import {
    deriveSqliteColumnEntries,
    fromBool,
    fromJson,
    fromNullableBool,
    fromOptional,
    sqliteColumnsFromEntries,
    sqliteMigrationColumnsFromEntries,
    sqliteRowFromColumnValues,
    toAttachments,
    toBool,
    toJson,
    toNullableBool,
    toStringArray,
    type EntityCloudWriteSemantics,
    type EntityFieldNullability,
    type EntitySqliteColumnType,
} from './entity-sync-schema';

export type ProjectSyncFieldSpec = {
    name: keyof Project;
    nullability: EntityFieldNullability;
    cloudSynced: boolean;
    cloudWrite: EntityCloudWriteSemantics;
    sqliteColumn: string | null;
    sqliteOrder: number | null;
    sqliteType: EntitySqliteColumnType | null;
};

type ProjectSyncSchemaFixture = {
    schemaVersion: number;
    fields: ProjectSyncFieldSpec[];
    fixture: Project;
};

const schema = schemaFixture as ProjectSyncSchemaFixture;

export const PROJECT_SYNC_SCHEMA_VERSION = schema.schemaVersion;
export const PROJECT_SYNC_FIELD_SCHEMA: readonly ProjectSyncFieldSpec[] = schema.fields;
export const PROJECT_SYNC_SCHEMA_FIXTURE: Project = schema.fixture;


const PROJECT_SQLITE_COLUMN_ENTRIES = deriveSqliteColumnEntries(PROJECT_SYNC_FIELD_SCHEMA, 'project-sync-schema');

export const PROJECT_SQLITE_COLUMNS: readonly string[] = sqliteColumnsFromEntries(PROJECT_SQLITE_COLUMN_ENTRIES);
export const PROJECT_SQLITE_MIGRATION_COLUMNS = sqliteMigrationColumnsFromEntries(PROJECT_SQLITE_COLUMN_ENTRIES, 'projects');


export const normalizeProjectStatus = (value: unknown): Project['status'] => {
    if (value === 'active' || value === 'someday' || value === 'waiting' || value === 'archived') {
        return value;
    }
    if (typeof value === 'string') {
        const lowered = value.toLowerCase().trim();
        if (lowered === 'active' || lowered === 'someday' || lowered === 'waiting' || lowered === 'archived') {
            return lowered as Project['status'];
        }
    }
    return 'active';
};


const projectColumnValues = (project: Project): Record<string, unknown> => ({
    id: project.id,
    title: project.title,
    status: project.status,
    color: project.color,
    colorOverride: project.colorOverride ?? null,
    orderNum: Number.isFinite(project.order) ? project.order : 0,
    tagIds: toJson(project.tagIds ?? []),
    isSequential: toBool(project.isSequential),
    sequentialScope: normalizeProjectSequentialScope(project.sequentialScope) ?? null,

    perSectionFlow: toNullableBool(project.perSectionFlow),
    taskSortBy: normalizeProjectTaskSortBy(project.taskSortBy) ?? null,
    isFocused: toBool(project.isFocused),
    supportNotes: project.supportNotes ?? null,
    attachments: toJson(project.attachments),
    dueDate: project.dueDate ?? null,
    startDate: project.startDate ?? null,
    reviewAt: project.reviewAt ?? null,
    cancelledAt: project.cancelledAt ?? null,
    archivedAt: project.archivedAt ?? null,
    areaId: project.areaId ?? null,
    areaTitle: project.areaTitle ?? null,
    rev: project.rev ?? null,
    revBy: project.revBy ?? null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    deletedAt: project.deletedAt ?? null,
    purgedAt: project.purgedAt ?? null,
    viewSectionIds: toJson(project.viewSectionIds),
    calendarReference: toJson(project.calendarReference),
});

export const projectToSqliteRow = (project: Project): unknown[] =>
    sqliteRowFromColumnValues(PROJECT_SQLITE_COLUMNS, projectColumnValues(project));


export const PROJECT_SQLITE_LEGACY_ROW_LENGTH = 26;


export const padProjectSqliteCells = (cells: readonly unknown[]): unknown[] | null => (
    cells.length >= PROJECT_SQLITE_LEGACY_ROW_LENGTH && cells.length <= PROJECT_SQLITE_COLUMNS.length
        ? [...cells, ...new Array<null>(PROJECT_SQLITE_COLUMNS.length - cells.length).fill(null)]
        : null
);


export const projectSqliteCellsFit = (cells: readonly unknown[], project: Project): boolean => (
    padProjectSqliteCells(cells) !== null
    && projectToSqliteRow(project).slice(cells.length).every((cell) => cell === null)
);


export const projectFromSqliteRow = (row: Record<string, unknown>): Project => {
    const orderNumRaw = row.orderNum;
    const fallbackOrder = typeof row._rowid === 'number' ? row._rowid : 0;
    return {
        id: String(row.id),
        title: String(row.title ?? ''),
        status: normalizeProjectStatus(row.status),
        color: String(row.color ?? '#6B7280'),
        colorOverride: fromOptional(row.colorOverride as string | null),
        order: orderNumRaw === null || orderNumRaw === undefined ? fallbackOrder : Number(orderNumRaw),
        tagIds: toStringArray(fromJson<unknown>(row.tagIds, [])),
        isSequential: fromBool(row.isSequential),
        sequentialScope: normalizeProjectSequentialScope(row.sequentialScope),
        perSectionFlow: fromOptional(fromNullableBool(row.perSectionFlow) ?? null),
        taskSortBy: normalizeProjectTaskSortBy(row.taskSortBy),
        isFocused: fromBool(row.isFocused),
        supportNotes: fromOptional(row.supportNotes as string | null),
        attachments: toAttachments(fromJson<unknown>(row.attachments, undefined)),
        dueDate: fromOptional(row.dueDate as string | null),
        startDate: fromOptional(row.startDate as string | null),
        reviewAt: fromOptional(row.reviewAt as string | null),
        cancelledAt: fromOptional(row.cancelledAt as string | null),
        archivedAt: fromOptional(row.archivedAt as string | null),
        areaId: fromOptional(row.areaId as string | null),
        areaTitle: fromOptional(row.areaTitle as string | null),
        rev: row.rev === null || row.rev === undefined ? undefined : Number(row.rev),
        revBy: fromOptional(row.revBy as string | null),
        createdAt: String(row.createdAt ?? ''),
        updatedAt: String(row.updatedAt ?? ''),
        deletedAt: fromOptional(row.deletedAt as string | null),
        purgedAt: fromOptional(row.purgedAt as string | null),
        viewSectionIds: fromJson<unknown>(row.viewSectionIds, undefined) as Project['viewSectionIds'],
        calendarReference: row.calendarReference === 'null' ? null
            : normalizeProjectCalendarReference(fromJson<unknown>(row.calendarReference, undefined)),
    };
};
