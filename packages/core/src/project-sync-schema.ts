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

// Generated SQLite column list + ensureProjectColumns migration list, both derived from
// PROJECT_SYNC_FIELD_SCHEMA above. Lives here (not in sqlite-adapter.ts) for the same reason
// task-sync-schema.ts does: scripts/check-synced-field-parity.ts imports these directly, and
// its "native-schema" CI job runs `bun run schema:check` with no `bun install` step, so
// nothing it imports may pull in a real npm dependency. sqlite-adapter.ts fails that bar (it
// transitively imports `date-fns`); this file and its fixture JSON don't.
const PROJECT_SQLITE_COLUMN_ENTRIES = deriveSqliteColumnEntries(PROJECT_SYNC_FIELD_SCHEMA, 'project-sync-schema');

export const PROJECT_SQLITE_COLUMNS: readonly string[] = sqliteColumnsFromEntries(PROJECT_SQLITE_COLUMN_ENTRIES);
export const PROJECT_SQLITE_MIGRATION_COLUMNS = sqliteMigrationColumnsFromEntries(PROJECT_SQLITE_COLUMN_ENTRIES, 'projects');

// Moved here from sqlite-adapter.ts (was a private, un-exported helper) so projectFromSqliteRow
// below and sqlite-adapter.ts's mapSearchProjectRow can share one implementation.
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

// Row codec pair: toRow/fromRow derived from the same PROJECT_SQLITE_COLUMN_ENTRIES the column
// list above comes from. Keying by column NAME (not array position) is what makes this safe
// against schema reordering — see the comment on sqliteRowFromColumnValues in
// entity-sync-schema.ts. Replaces the hand-written positional literal that used to live inline
// in sqlite-adapter.ts's saveData(), and the private mapProjectRow class method (also replaced;
// this is the same logic, byte-for-byte, just relocated and exported so MCP can reuse it too).
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
    // NULL keeps "never set" apart from an explicit false (#1429 old-client keep rule).
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
});

export const projectToSqliteRow = (project: Project): unknown[] =>
    sqliteRowFromColumnValues(PROJECT_SQLITE_COLUMNS, projectColumnValues(project));

/** Native journals frozen by v1.3.6 hold 26 project cells; colorOverride and perSectionFlow came later. */
export const PROJECT_SQLITE_LEGACY_ROW_LENGTH = 26;

/** A frozen raw project row padded to today's columns (later columns read as NULL), or null when no build wrote that length. */
export const padProjectSqliteCells = (cells: readonly unknown[]): unknown[] | null => (
    cells.length >= PROJECT_SQLITE_LEGACY_ROW_LENGTH && cells.length <= PROJECT_SQLITE_COLUMNS.length
        ? [...cells, ...new Array<null>(PROJECT_SQLITE_COLUMNS.length - cells.length).fill(null)]
        : null
);

/** A short frozen row fits a project only when every column it lacks is NULL for that project. */
export const projectSqliteCellsFit = (cells: readonly unknown[], project: Project): boolean => (
    padProjectSqliteCells(cells) !== null
    && projectToSqliteRow(project).slice(cells.length).every((cell) => cell === null)
);

// `_rowid` is the SQLite rowid the read query aliases in (sqlite-adapter.ts's loadAllRows);
// absent (e.g. MCP's own SELECTs, which don't alias it), the fallback below matches MCP's
// pre-existing `row.orderNum ?? 0` exactly.
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
    };
};
