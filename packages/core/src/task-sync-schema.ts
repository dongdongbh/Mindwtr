


import schemaFixture from './task-sync-schema.fixture.json';
import { normalizeDueReminderLeadMinutes, normalizeStartReminderLeadMinutes } from './due-reminder-lead';
import type { Task } from './types';
import { normalizeTaskStatus } from './task-status';
import { isSingleTaskReminder, normalizeTaskReminderPolicy } from './task-reminder-policy';
import {
    fromBool,
    fromJson,
    fromNullableBool,
    fromPresentBool,
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


    sqliteOrder: number | null;


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


export const TASK_SQLITE_MIGRATION_COLUMNS: readonly { name: string; sql: string }[] = TASK_SQLITE_COLUMN_ENTRIES
    .filter((entry) => entry.sqlType !== null)
    .map((entry) => ({ name: entry.column, sql: `ALTER TABLE tasks ADD COLUMN ${entry.column} ${entry.sqlType}` }));


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
        dueReminderLeadMinutes: normalizeDueReminderLeadMinutes(task.dueReminderLeadMinutes) ?? null,
        startReminderLeadMinutes: normalizeStartReminderLeadMinutes(task.startReminderLeadMinutes) ?? null,
        tags: toJson(task.tags ?? []),
        contexts: toJson(task.contexts ?? []),
        checklist: toJson(toChecklist(task.checklist)),
        description: task.description ?? null,
        textDirection: task.textDirection ?? null,
        attachments: toJson(task.attachments),
        location: task.location ?? null,
        projectId: task.projectId ?? null,
        sectionId: task.sectionId ?? null,
        viewSectionIds: toJson(task.viewSectionIds),
        areaId: task.areaId ?? null,


        orderNum: Number.isFinite(taskOrder) ? taskOrder : null,
        boardOrder: Number.isFinite(task.boardOrder) ? task.boardOrder : null,
        focusOrder: Number.isFinite(task.focusOrder) ? task.focusOrder : null,
        isFocusedToday: toBool(task.isFocusedToday),
        timeEstimate: task.timeEstimate ?? null,
        timeSpentMinutes: task.timeSpentMinutes ?? null,
        suppressMindwtrReminders: toBool(isSingleTaskReminder(task) || task.suppressMindwtrReminders),
        reminderPolicy: normalizeTaskReminderPolicy(task.reminderPolicy) ?? null,
        reviewAt: task.reviewAt ?? null,
        completedAt: task.completedAt ?? null,
        cancelledAt: task.cancelledAt ?? null,
        archivedAt: task.archivedAt ?? null,
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
    const recurrence = fromJson<unknown>(row.recurrence, null) as Task['recurrence'];
    const orderNumRaw = row.orderNum;
    const order = orderNumRaw === null || orderNumRaw === undefined ? undefined : Number(orderNumRaw);
    const loadedStatus = normalizeTaskStatus(String(row.status ?? ''));
    return {
        id: String(row.id),
        title: String(row.title ?? ''),
        status: row.status as Task['status'],
        priority: (row.priority as Task['priority'] | null) ?? undefined,
        energyLevel: (row.energyLevel as Task['energyLevel'] | null) ?? undefined,
        assignedTo: (row.assignedTo as string | null) ?? undefined,
        taskMode: (row.taskMode as Task['taskMode'] | null) ?? undefined,
        startTime: (row.startTime as string | null) ?? undefined,
        relativeStartOffset: fromJson<unknown>(row.relativeStartOffset, undefined) as Task['relativeStartOffset'],
        dueDate: (row.dueDate as string | null) ?? undefined,
        recurrence,

        showFutureRecurrence: recurrence ? fromPresentBool(row.showFutureRecurrence) : undefined,
        pushCount: row.pushCount === null || row.pushCount === undefined ? undefined : Number(row.pushCount),
        repeatReminderMinutes: row.repeatReminderMinutes === null || row.repeatReminderMinutes === undefined
            ? undefined
            : Number(row.repeatReminderMinutes),
        dueReminderLeadMinutes: normalizeDueReminderLeadMinutes(row.dueReminderLeadMinutes),
        startReminderLeadMinutes: normalizeStartReminderLeadMinutes(row.startReminderLeadMinutes),
        tags: toStringArray(fromJson<unknown>(row.tags, [])),
        contexts: toStringArray(fromJson<unknown>(row.contexts, [])),
        checklist: toChecklist(fromJson<unknown>(row.checklist, undefined)),
        description: (row.description as string | null) ?? undefined,
        textDirection: (row.textDirection as Task['textDirection'] | null) ?? undefined,
        attachments: toAttachments(fromJson<unknown>(row.attachments, undefined)),
        location: (row.location as string | null) ?? undefined,
        projectId: (row.projectId as string | null) ?? undefined,
        sectionId: (row.sectionId as string | null) ?? undefined,
        viewSectionIds: fromJson<unknown>(row.viewSectionIds, undefined) as Task['viewSectionIds'],
        areaId: (row.areaId as string | null) ?? undefined,
        order,
        orderNum: order,
        boardOrder: row.boardOrder === null || row.boardOrder === undefined ? undefined : Number(row.boardOrder),
        focusOrder: row.focusOrder === null || row.focusOrder === undefined ? undefined : Number(row.focusOrder),
        isFocusedToday: fromBool(row.isFocusedToday),
        timeEstimate: (row.timeEstimate as Task['timeEstimate'] | null) ?? undefined,
        timeSpentMinutes: row.timeSpentMinutes === null || row.timeSpentMinutes === undefined
            ? undefined
            : Number(row.timeSpentMinutes),
        suppressMindwtrReminders: fromBool(row.suppressMindwtrReminders),
        reminderPolicy: normalizeTaskReminderPolicy(row.reminderPolicy),
        reviewAt: (row.reviewAt as string | null) ?? undefined,


        completedAt: loadedStatus === 'done' || loadedStatus === 'archived'
            ? (row.completedAt as string | null) ?? undefined
            : undefined,
        cancelledAt: (row.cancelledAt as string | null) ?? undefined,
        archivedAt: (row.archivedAt as string | null) ?? undefined,
        statusBeforeProjectArchive: (row.statusBeforeProjectArchive as Task['statusBeforeProjectArchive'] | null) ?? undefined,


        completedAtBeforeProjectArchive: (row.completedAtBeforeProjectArchive as string | null) ?? undefined,
        isFocusedTodayBeforeProjectArchive: fromNullableBool(row.isFocusedTodayBeforeProjectArchive) ?? undefined,
        projectArchivedAt: (row.projectArchivedAt as string | null) ?? undefined,
        rev: row.rev === null || row.rev === undefined ? undefined : Number(row.rev),
        revBy: (row.revBy as string | null) ?? undefined,
        createdAt: String(row.createdAt ?? ''),
        updatedAt: String(row.updatedAt ?? ''),
        deletedAt: (row.deletedAt as string | null) ?? undefined,
        purgedAt: (row.purgedAt as string | null) ?? undefined,
    };
};
