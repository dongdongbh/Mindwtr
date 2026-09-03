// Adding or changing a `cloudKit` mapping below (a non-null TaskCloudKitFieldSpec)
// also requires a decision in packages/core/src/cloudkit-production-schema.json:
// list the field's cloudKit.key under `records.MindwtrTask.pendingProduction`
// until the CloudKit Dashboard's Production container actually has it, then move
// it to that record's `deployed` list.
// scripts/check-synced-field-parity.ts fails if a mapped key is missing from both
// lists (or in both, or stale), and `--release-gate` (wired into the stable release
// workflow only) additionally fails while anything is still pending. RCs may ship
// with a field pending; stable releases may not.
import schemaFixture from './task-sync-schema.fixture.json';
import type { Task } from './types';
import {
    fromBool,
    fromJson,
    fromNullableBool,
    fromPresentBool,
    fromOptional,
    isRecord,
    sqliteRowFromColumnValues,
    toAttachments,
    toBool,
    toJson,
    toNullableBool,
    toStringArray,
} from './entity-sync-schema';

export type TaskFieldSyncSemantics =
    | 'identity'
    | 'content'
    | 'archive-metadata'
    | 'revision-metadata'
    | 'tombstone'
    | 'order'
    | 'legacy-alias';

export type TaskFieldNullability = 'required' | 'optional' | 'optional-nullable';
export type TaskFieldSignatureSemantics = 'content' | 'ignored' | 'opaque';
export type TaskCloudWriteSemantics = 'create-patch' | 'patch' | 'managed';
export type TaskCloudKitFieldKind =
    | 'string'
    | 'date'
    | 'json-string'
    | 'boolean'
    | 'integer'
    | 'string-array';

export type TaskCloudKitFieldSpec = {
    key: string;
    kind: TaskCloudKitFieldKind;
};

export type TaskSqliteColumnType = 'TEXT' | 'INTEGER';

export type TaskSyncFieldSpec = {
    name: keyof Task;
    sync: TaskFieldSyncSemantics;
    nullability: TaskFieldNullability;
    sinceVersion: number;
    signature: TaskFieldSignatureSemantics;
    sqliteColumn: string | null;
    cloudKit: TaskCloudKitFieldSpec | null;
    cloudWrite: TaskCloudWriteSemantics;
    /**
     * Position of `sqliteColumn` in TASK_SQLITE_COLUMNS / the upsert clause /
     * the ensureTaskColumns migration list. Required whenever sqliteColumn is
     * set (multiple fields, e.g. `order`/`orderNum`, may share a column and
     * therefore the same position — the generator dedupes by column name).
     * SQL column order is load-bearing for row-building call sites that zip
     * TASK_SQLITE_COLUMNS with taskToSqliteRow's positional values.
     */
    sqliteOrder: number | null;
    /** SQL type for the ensureTaskColumns ALTER TABLE migration. Null for the
     *  three base columns (id/title/status) that ship in the CREATE TABLE
     *  itself and therefore never appear in the migration list. */
    sqliteType: TaskSqliteColumnType | null;
};

type TaskSyncSchemaFixture = {
    schemaVersion: number;
    sinceVersionPolicy: string;
    fields: TaskSyncFieldSpec[];
    fixture: Task;
};

const schema = schemaFixture as TaskSyncSchemaFixture;

export const TASK_SYNC_SCHEMA_VERSION = schema.schemaVersion;
export const TASK_SYNC_SCHEMA_VERSION_POLICY = schema.sinceVersionPolicy;
export const TASK_SYNC_FIELD_SCHEMA: readonly TaskSyncFieldSpec[] = schema.fields;
export const TASK_SYNC_SCHEMA_FIXTURE: Task = schema.fixture;

// Generated SQLite column list + ensureTaskColumns migration list, both derived from
// TASK_SYNC_FIELD_SCHEMA above. This lives here (not in sqlite-adapter.ts, which
// re-exports TASK_SQLITE_COLUMNS for its existing consumers and builds
// TASK_UPSERT_UPDATE_CLAUSE from it) because scripts/check-synced-field-parity.ts imports
// these two directly, and that script's "native-schema" CI job runs `bun run schema:check`
// on a fresh macOS checkout with no `bun install` step — nothing it imports may pull in a
// real npm dependency. sqlite-adapter.ts fails that bar (it transitively imports
// `date-fns` via recurrence.ts/saved-filters.ts); this file and its fixture JSON don't.
//
// Column ORDER here is load-bearing: sqlite-adapter.ts's taskToSqliteRow returns values
// positionally zipped against TASK_SQLITE_COLUMNS, and the upsert update clause derives
// from it too. Each field's `sqliteOrder` pins its position; fields that share a
// `sqliteColumn` (`order`/`orderNum` both write the same `orderNum` column) collapse to
// one entry, keeping the position of whichever field is declared first in the schema.
type TaskSqliteColumnEntry = {
    column: string;
    order: number;
    sqlType: TaskSqliteColumnType | null;
};

function deriveTaskSqliteColumnEntries(): TaskSqliteColumnEntry[] {
    const seen = new Set<string>();
    const entries: TaskSqliteColumnEntry[] = [];
    for (const field of TASK_SYNC_FIELD_SCHEMA) {
        if (field.sqliteColumn === null || seen.has(field.sqliteColumn)) continue;
        if (field.sqliteOrder === null) {
            throw new Error(`task-sync-schema: "${field.name}" declares sqliteColumn without sqliteOrder`);
        }
        seen.add(field.sqliteColumn);
        entries.push({ column: field.sqliteColumn, order: field.sqliteOrder, sqlType: field.sqliteType });
    }
    return entries.sort((a, b) => a.order - b.order);
}

const TASK_SQLITE_COLUMN_ENTRIES: TaskSqliteColumnEntry[] = deriveTaskSqliteColumnEntries();

export const TASK_SQLITE_COLUMNS: readonly string[] = TASK_SQLITE_COLUMN_ENTRIES.map((entry) => entry.column);

// The migration list ensureTaskColumns() runs at startup: every synced column
// except the three (id/title/status) that ship in the base CREATE TABLE.
export const TASK_SQLITE_MIGRATION_COLUMNS: readonly { name: string; sql: string }[] = TASK_SQLITE_COLUMN_ENTRIES
    .filter((entry) => entry.sqlType !== null)
    .map((entry) => ({ name: entry.column, sql: `ALTER TABLE tasks ADD COLUMN ${entry.column} ${entry.sqlType}` }));

// Task-only: filters/shapes checklist items on read. (toAttachments is shared with Project and
// lives in entity-sync-schema.ts; checklist has no equivalent on any other entity.)
const toChecklist = (value: unknown): Task['checklist'] => {
    if (!Array.isArray(value)) return undefined;
    const cleaned = value
        .filter(isRecord)
        .filter((item) => typeof item.id === 'string' && typeof item.title === 'string')
        .map((item) => ({
            id: item.id as string,
            title: item.title as string,
            isCompleted: Boolean(item.isCompleted),
        }));
    return cleaned.length > 0 ? cleaned : undefined;
};

// Row codec pair — see the equivalent comment in project-sync-schema.ts for the "keyed by
// column name, not array position" rationale. taskToSqliteRow replaces the previous
// hand-written positional literal in sqlite-adapter.ts (byte-for-byte identical output).
//
// taskFromSqliteRow is intentionally *not* the full task-status/recurrence/relative-start-offset
// normalization mapSqliteTaskRow (sqlite-adapter.ts) applies — normalizeTaskStatus,
// normalizeRecurrenceForLoad, and normalizeRelativeStartOffset all transitively import
// date-fns (via recurrence.ts / date.ts), which this file may not pull in (see the
// zero-dependency header comment above). Those three fields come back here as the plain
// decoded value (a raw string / parsed JSON); sqlite-adapter.ts's mapSqliteTaskRow layers the
// three normalizers on top of this function's output, so the final, exported mapper's
// behaviour is unchanged. For a fixture already in canonical form (as TASK_SYNC_SCHEMA_FIXTURE
// is), the un-normalized and normalized values are identical, so the round-trip test in
// sync-schema-row-codec.test.ts holds against either function.
const taskColumnValues = (task: Task): Record<string, unknown> => {
    const taskOrder = Number.isFinite(task.order) ? task.order : task.orderNum;
    return {
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority ?? null,
        energyLevel: task.energyLevel ?? null,
        assignedTo: task.assignedTo ?? null,
        taskMode: task.taskMode ?? null,
        startTime: task.startTime ?? null,
        relativeStartOffset: toJson(task.relativeStartOffset),
        dueDate: task.dueDate ?? null,
        recurrence: toJson(task.recurrence),
        showFutureRecurrence: toBool(task.showFutureRecurrence),
        pushCount: task.pushCount ?? null,
        repeatReminderMinutes: task.repeatReminderMinutes ?? null,
        tags: toJson(task.tags ?? []),
        contexts: toJson(task.contexts ?? []),
        checklist: toJson(task.checklist),
        description: task.description ?? null,
        textDirection: task.textDirection ?? null,
        attachments: toJson(task.attachments),
        location: task.location ?? null,
        projectId: task.projectId ?? null,
        sectionId: task.sectionId ?? null,
        viewSectionIds: toJson(task.viewSectionIds),
        areaId: task.areaId ?? null,
        // `order` and `orderNum` are the same SQLite column (legacy alias); a plain object
        // literal can't have two entries for one key, so this naturally collapses them the
        // same way deriveTaskSqliteColumnEntries collapses the schema's two field entries.
        orderNum: Number.isFinite(taskOrder) ? taskOrder : null,
        boardOrder: Number.isFinite(task.boardOrder) ? task.boardOrder : null,
        focusOrder: Number.isFinite(task.focusOrder) ? task.focusOrder : null,
        isFocusedToday: toBool(task.isFocusedToday),
        timeEstimate: task.timeEstimate ?? null,
        timeSpentMinutes: task.timeSpentMinutes ?? null,
        suppressMindwtrReminders: toBool(task.suppressMindwtrReminders),
        reviewAt: task.reviewAt ?? null,
        completedAt: task.completedAt ?? null,
        statusBeforeProjectArchive: task.statusBeforeProjectArchive ?? null,
        completedAtBeforeProjectArchive: task.completedAtBeforeProjectArchive ?? null,
        isFocusedTodayBeforeProjectArchive: toNullableBool(task.isFocusedTodayBeforeProjectArchive),
        projectArchivedAt: task.projectArchivedAt ?? null,
        rev: task.rev ?? null,
        revBy: task.revBy ?? null,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        deletedAt: task.deletedAt ?? null,
        purgedAt: task.purgedAt ?? null,
    };
};

export const taskToSqliteRow = (task: Task): unknown[] =>
    sqliteRowFromColumnValues(TASK_SQLITE_COLUMNS, taskColumnValues(task));

export const taskFromSqliteRow = (row: Record<string, unknown>): Task => {
    const orderNumRaw = row.orderNum;
    const order = orderNumRaw === null || orderNumRaw === undefined ? undefined : Number(orderNumRaw);
    return {
        id: String(row.id),
        title: String(row.title ?? ''),
        status: row.status as Task['status'],
        priority: fromOptional(row.priority as Task['priority'] | null),
        energyLevel: fromOptional(row.energyLevel as Task['energyLevel'] | null),
        assignedTo: fromOptional(row.assignedTo as string | null),
        taskMode: fromOptional(row.taskMode as Task['taskMode'] | null),
        startTime: fromOptional(row.startTime as string | null),
        relativeStartOffset: fromJson<unknown>(row.relativeStartOffset, undefined) as Task['relativeStartOffset'],
        dueDate: fromOptional(row.dueDate as string | null),
        recurrence: fromJson<unknown>(row.recurrence, null) as Task['recurrence'],
        // `true | undefined`, never `false` — see fromPresentBool.
        showFutureRecurrence: fromPresentBool(row.showFutureRecurrence),
        pushCount: row.pushCount === null || row.pushCount === undefined ? undefined : Number(row.pushCount),
        repeatReminderMinutes: row.repeatReminderMinutes === null || row.repeatReminderMinutes === undefined
            ? undefined
            : Number(row.repeatReminderMinutes),
        tags: toStringArray(fromJson<unknown>(row.tags, [])),
        contexts: toStringArray(fromJson<unknown>(row.contexts, [])),
        checklist: toChecklist(fromJson<unknown>(row.checklist, undefined)),
        description: fromOptional(row.description as string | null),
        textDirection: fromOptional(row.textDirection as Task['textDirection'] | null),
        attachments: toAttachments(fromJson<unknown>(row.attachments, undefined)),
        location: fromOptional(row.location as string | null),
        projectId: fromOptional(row.projectId as string | null),
        sectionId: fromOptional(row.sectionId as string | null),
        viewSectionIds: fromJson<unknown>(row.viewSectionIds, undefined) as Task['viewSectionIds'],
        areaId: fromOptional(row.areaId as string | null),
        order,
        orderNum: order,
        boardOrder: row.boardOrder === null || row.boardOrder === undefined ? undefined : Number(row.boardOrder),
        focusOrder: row.focusOrder === null || row.focusOrder === undefined ? undefined : Number(row.focusOrder),
        isFocusedToday: fromBool(row.isFocusedToday),
        timeEstimate: fromOptional(row.timeEstimate as Task['timeEstimate'] | null),
        timeSpentMinutes: row.timeSpentMinutes === null || row.timeSpentMinutes === undefined
            ? undefined
            : Number(row.timeSpentMinutes),
        suppressMindwtrReminders: fromBool(row.suppressMindwtrReminders),
        reviewAt: fromOptional(row.reviewAt as string | null),
        completedAt: fromOptional(row.completedAt as string | null),
        statusBeforeProjectArchive: fromOptional(row.statusBeforeProjectArchive as Task['statusBeforeProjectArchive'] | null),
        // Nullable BY DESIGN (Task.completedAtBeforeProjectArchive: string | null) — do not
        // route through fromOptional, a stored `null` must stay `null`.
        completedAtBeforeProjectArchive: row.completedAtBeforeProjectArchive as string | null | undefined,
        // Nullable BY DESIGN (Task.isFocusedTodayBeforeProjectArchive: boolean | null) —
        // fromNullableBool already preserves null as null.
        isFocusedTodayBeforeProjectArchive: fromNullableBool(row.isFocusedTodayBeforeProjectArchive),
        projectArchivedAt: fromOptional(row.projectArchivedAt as string | null),
        rev: row.rev === null || row.rev === undefined ? undefined : Number(row.rev),
        revBy: fromOptional(row.revBy as string | null),
        createdAt: String(row.createdAt ?? ''),
        updatedAt: String(row.updatedAt ?? ''),
        deletedAt: fromOptional(row.deletedAt as string | null),
        purgedAt: fromOptional(row.purgedAt as string | null),
    };
};
