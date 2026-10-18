import type { NativeHostResult } from './native-host-contract';
import type { PreparedTaskEdit } from './store-types';
import type { Area, Attachment, Project, Section, Task } from './types';
import { getPersistenceStatus, getStorageAdapter, useTaskStore } from './store';
import { applyTaskUpdates, createProjectOrderReserver, ensureDeviceId, findTaskProjectReactivationTarget,
    getNextProjectOrder, nextRevision, normalizeTaskUpdate } from './store-helpers';
import { applyPreparedTaskEditChanges, buildPreparedTaskEditChanges, prepareTaskUpdatesForStore, taskEditValuesEqual } from './store-tasks';
import { createTaskDraft, resolveTaskDraftTitle, taskDraftToUpdatePatch, type TaskDraft, type TaskDraftField } from './task-draft';
import { applyTaskDraftPatch, buildTaskEditUpdatePatch } from './task-editor-model';
import { isStatusListTaskReadOnly } from './menu-views-model';
import { isSelectableProjectForTaskAssignment } from './project-utils';
import { normalizeRelativeStartOffset } from './task-relative-start';
import { normalizeCancellationTimestamp } from './task-status';
import { normalizeTimeSpentMinutes } from './time-spent';
import { normalizeRecurrenceForLoad } from './recurrence';
import { hasTimeComponent } from './date';
import { logInfo } from './logger';
import { createAreaSaveGuard, readAreaDurableData } from './native-host-contract-area-durable';
import { TASK_SYNC_FIELD_SCHEMA, taskToSqliteRow } from './task-sync-schema';
import { sameSectionDeleteJson, sameTaskSqliteRow } from './store-projects/section-actions';
import { mergeNativeTaskLinkHalf, readNativeTaskLinkHalf } from './native-host-contract-attachments';
import { taskRevisionOf } from './native-request-receipts';
import { getAdvancedReviewDate, isTaskDueForReview } from './review-utils';
import type { NativeReviewAction } from './native-host-contract-review-views';

export type NativeTaskScheduleBase = {
    startTime: string | null;
    dueDate: string | null;
    relativeStartOffset: Exclude<Task['relativeStartOffset'], undefined> | null;
    reviewAt: string | null;
};
export type NativeTaskRecurrenceBase = {
    recurrence: Exclude<Task['recurrence'], undefined> | null;
    showFutureRecurrence: boolean | null;
};
type SaveField = 'title' | 'description' | 'location' | 'assignedTo' | 'priority' | 'energyLevel' | 'timeEstimate' | 'contexts' | 'tags' | 'status'
    | 'focusedToday' | 'completedAt' | 'timeSpentMinutes'
    | 'projectId' | 'areaId' | 'sectionId' | 'startTime' | 'dueDate' | 'reviewAt' | 'relativeStartOffset'
    | 'recurrence' | 'preserveChecklistOnRepeat' | 'recurrenceStrategy' | 'recurrenceRRule' | 'showFutureRecurrence';
type SaveFields = Partial<{ [K in SaveField]: Exclude<TaskDraft[K], undefined>
    | (K extends 'relativeStartOffset' | 'timeSpentMinutes' ? null : never) }>;
export type NativeTaskDraftSaveRequest = {
    id: string;
    base: SaveFields;
    patch: SaveFields;
    scheduleBase: NativeTaskScheduleBase;
    /** Required exactly when the complete recurrence draft tuple is supplied. */
    recurrenceBase?: NativeTaskRecurrenceBase;
    attachments?: { base: Attachment[]; value: Attachment[] };
};
/** Private journal payload. The host persists this exact result before commit. */
export type NativePreparedTaskDraftSave = PreparedTaskEdit & { version: 1; request: NativeTaskDraftSaveRequest };
type ProjectEligibilityWitness = { id: string; status: Project['status']; deletedAt: string | null;
    purgedAt: string | null; rev: number | null; revBy: string | null; updatedAt: string };
type SectionEligibilityWitness = { id: string; projectId: string; deletedAt: string | null;
    rev: number | null; revBy: string | null; updatedAt: string };
type AreaEligibilityWitness = { id: string; deletedAt: string | null;
    rev: number | null; revBy: string | null; updatedAt: string };
export type NativePreparedTaskDraftSaveV2 = {
    version: 2;
    request: NativeTaskDraftSaveRequest;
    preparedAt: string;
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    scope: { sourceProject: ProjectEligibilityWitness | null; targetProject: ProjectEligibilityWitness | null;
        targetSection: SectionEligibilityWitness | null; targetArea: AreaEligibilityWitness | null;
        nextProjectOrder: number | null };
    effect: { task: { before: Task; after: Task } };
};
export type NativePreparedTaskDraftSaveAny = NativePreparedTaskDraftSave | NativePreparedTaskDraftSaveV2;
/** Private selected-file authority only; legacy prepared V2 remains change-only. */
export type NativeOwnedTaskDraftNoopDecision = {
    kind: 'noop'; preparedAt: string; deviceIdBefore: string | null;
    scope: NativePreparedTaskDraftSaveV2['scope'];
    effect: NativePreparedTaskDraftSaveV2['effect'];
};
export type NativeReviewTaskWriteInput = Extract<NativeReviewAction, { type: 'markTaskReviewed' }>;

const FIELDS: readonly SaveField[] = ['title', 'description', 'location', 'assignedTo', 'priority', 'energyLevel', 'timeEstimate', 'contexts', 'tags', 'status', 'focusedToday', 'completedAt', 'timeSpentMinutes',
    'projectId', 'areaId', 'sectionId', 'startTime', 'dueDate', 'reviewAt', 'relativeStartOffset',
    'recurrence', 'preserveChecklistOnRepeat', 'recurrenceStrategy', 'recurrenceRRule', 'showFutureRecurrence'];
const STORED_FIELDS = FIELDS.filter((field) => field !== 'preserveChecklistOnRepeat' && field !== 'recurrenceStrategy' && field !== 'recurrenceRRule' && field !== 'focusedToday');
export const SCHEDULE = ['startTime', 'dueDate', 'relativeStartOffset', 'reviewAt'] as const;
export const RECURRENCE = ['recurrence', 'preserveChecklistOnRepeat', 'recurrenceStrategy', 'recurrenceRRule', 'showFutureRecurrence'] as const;
export const ASSOCIATIONS = ['projectId', 'areaId', 'sectionId'] as const;
export const LIFECYCLE = ['status', 'focusedToday', 'completedAt'] as const;
const REFERENCE_FIELDS = new Set<SaveField>(['title', 'description', 'location', 'assignedTo', 'contexts', 'tags', 'energyLevel',
    'projectId', 'areaId', 'sectionId']);
const referenceEditable = (request: NativeTaskDraftSaveRequest): boolean => Object.keys(request.patch)
    .every((field) => REFERENCE_FIELDS.has(field as SaveField)
        || (field === 'priority' || field === 'timeEstimate') && request.patch[field] === '');
const recurrenceRuleEdited = (request: NativeTaskDraftSaveRequest): boolean =>
    (['recurrence', 'preserveChecklistOnRepeat', 'recurrenceStrategy', 'recurrenceRRule'] as const)
        .some((field) => own(request.patch, field) && !taskEditValuesEqual(request.patch[field], request.base[field]));
const recurrenceFlagEdited = (request: NativeTaskDraftSaveRequest): boolean =>
    own(request.patch, 'showFutureRecurrence')
        && !taskEditValuesEqual(request.patch.showFutureRecurrence, request.base.showFutureRecurrence);
const EFFECTS = ['status', 'isFocusedToday', 'focusOrder', 'boardOrder', 'order', 'orderNum', 'pushCount',
    'completedAt', 'cancelledAt', 'statusBeforeProjectArchive', 'completedAtBeforeProjectArchive',
    'isFocusedTodayBeforeProjectArchive', 'projectArchivedAt'];
const own = (value: object, field: string) => Object.prototype.hasOwnProperty.call(value, field);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: readonly string[]) => Object.keys(value).length === expected.length && expected.every((field) => own(value, field));
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'TASK_NOT_FOUND' | 'SAVE_FAILED', message: string): NativeHostResult<never> => ({ ok: false, error: { code, message } });

// Strict JSON, including explicit null clears. Do not silently lose undefined,
// non-finite numbers, prototypes, or cyclic/oversized journal content.
const detach = (value: unknown, limit: number): unknown => {
    const check = (item: unknown, depth: number): boolean => {
        if (depth > 30) return false;
        if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
        if (typeof item === 'number') return Number.isFinite(item);
        if (Array.isArray(item)) return item.length <= 10_000 && item.every((entry) => check(entry, depth + 1));
        return record(item) && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)
            && Object.keys(item).length <= 256 && Object.entries(item).every(([name, entry]) =>
                !['__proto__', 'constructor', 'prototype'].includes(name) && check(entry, depth + 1));
    };
    if (!check(value, 0)) return null;
    const text = JSON.stringify(value);
    return text.length <= limit ? JSON.parse(text) : null;
};

/** Raw saved representation, detached from the task. Retain the opening model's baseline. */
export const getNativeTaskScheduleBase = (task: Task): NativeTaskScheduleBase => JSON.parse(JSON.stringify({
    startTime: task.startTime ?? null, dueDate: task.dueDate ?? null,
    relativeStartOffset: task.relativeStartOffset ?? null, reviewAt: task.reviewAt ?? null,
}));
export const getNativeTaskRecurrenceBase = (task: Task): NativeTaskRecurrenceBase => JSON.parse(JSON.stringify({
    recurrence: task.recurrence ?? null, showFutureRecurrence: task.showFutureRecurrence ?? null,
}));

export const nativeTaskDraftPatchValues = (request: NativeTaskDraftSaveRequest): Partial<TaskDraft> => Object.fromEntries(
    Object.entries(request.patch).map(([field, value]) => [field, value === null ? undefined : value]),
);
export const readNativeTaskDraftSaveRequest = (input: unknown, validateField: (field: TaskDraftField, value: unknown) => boolean, allowChecklist = false,
    allowPlain = false, allowAttachments = false): NativeTaskDraftSaveRequest | null => {
    const value = detach(input, 1_000_000);
    if (!record(value)
        || typeof value.id !== 'string' || !value.id.trim() || value.id.length > 500
        || !record(value.base) || !record(value.patch) || !record(value.scheduleBase)) return null;
    const fields = Object.keys(value.patch);
    const editsRecurrence = RECURRENCE.some((field) => own(value.patch as object, field));
    const attachments = own(value, 'attachments') && allowAttachments ? readNativeTaskLinkHalf(value.attachments) : null;
    if (!keys(value, ['id', 'base', 'patch', 'scheduleBase', ...(editsRecurrence ? ['recurrenceBase'] : []), ...(attachments ? ['attachments'] : [])])
        || (!allowChecklist && fields.length === 0 && !attachments)
        || (!allowChecklist && !allowPlain && !(editsRecurrence || fields.some((field) => (SCHEDULE as readonly string[]).includes(field))))
        || !keys(value.base, fields) || fields.some((field) => !(FIELDS as readonly string[]).includes(field)
            || (!allowChecklist && ['status', 'focusedToday', 'completedAt'].includes(field))
            || (field === 'timeSpentMinutes' && !allowChecklist && !allowPlain))) return null;
    // Older saved drafts own the recurrence group without the newly added checklist flag.
    if (editsRecurrence && (!RECURRENCE.every((field) => field === 'preserveChecklistOnRepeat' || own(value.patch as object, field))
        || !record(value.recurrenceBase) || !keys(value.recurrenceBase, ['recurrence', 'showFutureRecurrence'])
        || !(value.recurrenceBase.recurrence === null || typeof value.recurrenceBase.recurrence === 'string' || record(value.recurrenceBase.recurrence))
        || !(value.recurrenceBase.showFutureRecurrence === null || typeof value.recurrenceBase.showFutureRecurrence === 'boolean'))) return null;
    if (ASSOCIATIONS.some((field) => own(value.patch as object, field))
        && !ASSOCIATIONS.every((field) => own(value.patch as object, field))) return null;
    const scheduleBase = value.scheduleBase;
    if (!keys(scheduleBase, SCHEDULE)
        || !['startTime', 'dueDate', 'reviewAt'].every((field) => scheduleBase[field] === null || typeof scheduleBase[field] === 'string')
        || !(value.scheduleBase.relativeStartOffset === null || record(value.scheduleBase.relativeStartOffset))) return null;
    for (const field of fields as SaveField[]) {
        const next = value.patch[field];
        const base = value.base[field];
        if ((RECURRENCE as readonly string[]).includes(field)
            ? !validateField(field, base)
            : field === 'focusedToday' ? typeof base !== 'boolean'
            : field === 'completedAt' ? !validateField(field, base)
            : field === 'timeSpentMinutes' ? !(base === null || validateField(field, base))
            : field === 'relativeStartOffset' ? !(base === null || record(base)) : typeof base !== 'string') return null;
        if (!validateField(field, next === null && ['relativeStartOffset', 'timeSpentMinutes'].includes(field) ? undefined : next)) return null;
    }
    return { ...value, ...(attachments ? { attachments } : {}) } as unknown as NativeTaskDraftSaveRequest;
};
export const serializeNativeTaskDraftDirect = (before: Task, request: NativeTaskDraftSaveRequest) => taskDraftToUpdatePatch({
    ...createTaskDraft(before), ...nativeTaskDraftPatchValues(request),
    ...(own(request.patch, 'title') ? { title: resolveTaskDraftTitle(request.patch.title!, request.base.title!) } : {}),
}, before);
export const validNativeTaskDraftBases = (before: Task, request: NativeTaskDraftSaveRequest,
    savedRaw = false): boolean => {
    if (!taskEditValuesEqual(getNativeTaskScheduleBase(before), request.scheduleBase)) return false;
    // Native opens the editor from the load projection. The v2 authority is
    // raw saved SQLite, so compare the frozen visible recurrence baseline to
    // that same projection while retaining the raw row for the write receipt.
    const displayed = savedRaw ? { ...before, timeSpentMinutes: normalizeTimeSpentMinutes(before.timeSpentMinutes) } : before;
    const projected = savedRaw ? { ...displayed, recurrence: normalizeRecurrenceForLoad(before.recurrence) } : before;
    const openingTask = savedRaw && request.recurrenceBase
        && taskEditValuesEqual(getNativeTaskRecurrenceBase(projected), request.recurrenceBase) ? projected : displayed;
    if (request.recurrenceBase && !taskEditValuesEqual(getNativeTaskRecurrenceBase(openingTask), request.recurrenceBase)) return false;
    const serialized = serializeNativeTaskDraftDirect(before, request);
    if (!serialized) return false;
    const current = createTaskDraft(openingTask);
    const next = createTaskDraft({ ...openingTask, ...serialized });
    return (Object.keys(request.patch) as SaveField[]).every((field) => (SCHEDULE as readonly string[]).includes(field)
        || taskEditValuesEqual(current[field], request.base[field])
        || (!(RECURRENCE as readonly string[]).includes(field) && taskEditValuesEqual(current[field], next[field])));
};


/** Bind direct dates and frozen linked-start shape without reparsing in a new zone. */
export const validNativeTaskDraftScheduleEffect = (before: Task, request: NativeTaskDraftSaveRequest, after: Task,
    validateField: (field: TaskDraftField, value: unknown) => boolean): boolean => {
    for (const field of ['dueDate', 'reviewAt'] as const) {
        const expected = own(request.patch, field) ? request.patch[field] || undefined : before[field];
        if (!taskEditValuesEqual(after[field], expected)) return false;
    }
    const linkedEdit = ['dueDate', 'startTime', 'relativeStartOffset'].some((field) => own(request.patch, field));
    const offset = normalizeRelativeStartOffset(own(request.patch, 'relativeStartOffset') ? request.patch.relativeStartOffset : before.relativeStartOffset);
    const mustClearOffset = own(request.patch, 'relativeStartOffset') && request.patch.relativeStartOffset === null
        || !after.dueDate || Boolean(offset && !hasTimeComponent(after.dueDate) && ['minute', 'hour'].includes(offset.unit));
    if (!linkedEdit) {
        if (!taskEditValuesEqual(after.startTime, before.startTime) || !taskEditValuesEqual(after.relativeStartOffset, before.relativeStartOffset)) return false;
    } else {
        if (mustClearOffset && after.relativeStartOffset != null) return false;
        if (after.relativeStartOffset != null && !taskEditValuesEqual(after.relativeStartOffset, offset)) return false;
        // A due-only edit retains a usable existing link. Only an explicit
        // start edit can break it without one of the deterministic clears.
        const retainsOffset = own(request.patch, 'relativeStartOffset') || !own(request.patch, 'startTime');
        if (!mustClearOffset && retainsOffset && offset && !taskEditValuesEqual(after.relativeStartOffset, offset)) return false;
        if (after.relativeStartOffset) {
            // Frozen derived output: validate shape/representation, not a
            // second calculation in the recovery process's timezone.
            if (!after.startTime || !validateField('startTime', after.startTime)
                || hasTimeComponent(after.startTime) !== hasTimeComponent(after.dueDate)
                || (/Z$|[+-]\d{2}:?\d{2}$/.test(after.startTime) !== /Z$|[+-]\d{2}:?\d{2}$/.test(after.dueDate!))) return false;
        } else if (!taskEditValuesEqual(after.startTime, own(request.patch, 'startTime') ? request.patch.startTime || undefined : before.startTime)) return false;
    }
    return true;
};

const TASK_KEYS = new Set(TASK_SYNC_FIELD_SCHEMA.map((field) => field.name));
const iso = (value: unknown): value is string => typeof value === 'string' && value.length <= 50
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const nullableText = (value: unknown): value is string | null => value === null
    || typeof value === 'string' && value.length <= 500;
const nullableRevision = (value: unknown): value is number | null => value === null
    || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const validRawTask = (value: unknown, id: string): value is Task => {
    if (!record(value) || Object.keys(value).some((key) => !TASK_KEYS.has(key as keyof Task))) return false;
    const row = Object.fromEntries(Object.entries(value).map(([key, part]) => [key, part === null ? undefined : part]));
    if (row.id !== id || typeof row.title !== 'string'
        || !['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'].includes(String(row.status))
        || !Array.isArray(row.tags) || !row.tags.every((part: unknown) => typeof part === 'string')
        || !Array.isArray(row.contexts) || !row.contexts.every((part: unknown) => typeof part === 'string')
        || !iso(row.createdAt) || !iso(row.updatedAt)
        || (row.rev !== undefined && !nullableRevision(row.rev))
        || (row.revBy !== undefined && !nullableText(row.revBy))) return false;
    try { taskToSqliteRow(value as unknown as Task); return true; }
    catch { return false; }
};
const projectWitness = (project: Project | undefined): ProjectEligibilityWitness | null => project ? ({
    id: project.id, status: project.status, deletedAt: project.deletedAt ?? null,
    purgedAt: project.purgedAt ?? null, rev: project.rev ?? null, revBy: project.revBy ?? null,
    updatedAt: project.updatedAt,
}) : null;
const sectionWitness = (section: Section | undefined): SectionEligibilityWitness | null => section ? ({
    id: section.id, projectId: section.projectId, deletedAt: section.deletedAt ?? null,
    rev: section.rev ?? null, revBy: section.revBy ?? null, updatedAt: section.updatedAt,
}) : null;
const areaWitness = (area: Area | undefined): AreaEligibilityWitness | null => area ? ({
    id: area.id, deletedAt: area.deletedAt ?? null, rev: area.rev ?? null,
    revBy: area.revBy ?? null, updatedAt: area.updatedAt,
}) : null;
const validProjectWitness = (value: unknown): value is ProjectEligibilityWitness => record(value)
    && keys(value, ['id', 'status', 'deletedAt', 'purgedAt', 'rev', 'revBy', 'updatedAt'])
    && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 500
    && ['active', 'someday', 'waiting', 'archived'].includes(String(value.status))
    && nullableText(value.deletedAt) && nullableText(value.purgedAt)
    && nullableRevision(value.rev) && nullableText(value.revBy) && iso(value.updatedAt);
const validSectionWitness = (value: unknown): value is SectionEligibilityWitness => record(value)
    && keys(value, ['id', 'projectId', 'deletedAt', 'rev', 'revBy', 'updatedAt'])
    && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 500
    && typeof value.projectId === 'string' && value.projectId.length > 0 && value.projectId.length <= 500
    && nullableText(value.deletedAt) && nullableRevision(value.rev)
    && nullableText(value.revBy) && iso(value.updatedAt);
const validAreaWitness = (value: unknown): value is AreaEligibilityWitness => record(value)
    && keys(value, ['id', 'deletedAt', 'rev', 'revBy', 'updatedAt'])
    && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 500
    && nullableText(value.deletedAt) && nullableRevision(value.rev)
    && nullableText(value.revBy) && iso(value.updatedAt);

const taskResult = (task: Task): { id: string; draft: TaskDraft } => ({ id: task.id, draft: createTaskDraft(task) });
const rawTaskEqual = (left: Task, right: Task) => sameTaskSqliteRow(left, right)
    && sameSectionDeleteJson(left, right);

const draftSaveScope = (before: Task, request: NativeTaskDraftSaveRequest,
    data: { tasks: Task[]; projects: Project[]; sections: Section[]; areas: Area[] }): NativePreparedTaskDraftSaveV2['scope'] => {
    const moves = ASSOCIATIONS.some((field) => own(request.patch, field));
    const projectId = moves ? request.patch.projectId || undefined : before.projectId;
    const sectionId = moves ? request.patch.sectionId || undefined : before.sectionId;
    const areaId = moves ? request.patch.areaId || undefined : before.areaId;
    return {
        sourceProject: projectWitness(data.projects.find((row) => row.id === before.projectId)),
        targetProject: moves ? projectWitness(data.projects.find((row) => row.id === projectId)) : null,
        targetSection: moves ? sectionWitness(data.sections.find((row) => row.id === sectionId)) : null,
        targetArea: moves ? areaWitness(data.areas.find((row) => row.id === areaId)) : null,
        nextProjectOrder: moves && projectId && projectId !== before.projectId
            ? getNextProjectOrder(projectId, data.tasks) ?? null : null,
    };
};

/** Project/Area/Section stubs contain exactly the policy inputs frozen in scope. */
const scopeRows = (scope: NativePreparedTaskDraftSaveV2['scope']) => ({
    projects: [...new Map([scope.sourceProject, scope.targetProject].filter((value): value is ProjectEligibilityWitness => !!value)
        .map((value) => [value.id, { ...value, deletedAt: value.deletedAt ?? undefined,
            purgedAt: value.purgedAt ?? undefined, rev: value.rev ?? undefined,
            revBy: value.revBy ?? undefined, title: '', color: '', order: 0, tagIds: [], createdAt: value.updatedAt } as Project])).values()],
    sections: scope.targetSection ? [{ ...scope.targetSection, deletedAt: scope.targetSection.deletedAt ?? undefined,
        rev: scope.targetSection.rev ?? undefined, revBy: scope.targetSection.revBy ?? undefined,
        title: '', order: 0, createdAt: scope.targetSection.updatedAt } as Section] : [],
    areas: scope.targetArea ? [{ ...scope.targetArea, deletedAt: scope.targetArea.deletedAt ?? undefined,
        rev: scope.targetArea.rev ?? undefined, revBy: scope.targetArea.revBy ?? undefined,
        name: '', order: 0, createdAt: scope.targetArea.updatedAt } as Area] : [],
});

const draftSaveEffect = (before: Task, request: NativeTaskDraftSaveRequest,
    scope: NativePreparedTaskDraftSaveV2['scope'], preparedAt: string, deviceId: string,
    mergeAttachments = mergeNativeTaskLinkHalf): Task | null => {
    if (!validNativeTaskDraftBases(before, request, true)) return null;
    const attachments = request.attachments
        ? mergeAttachments(before.attachments ?? [], request.attachments) : before.attachments;
    if (attachments === null) return null;
    const rows = scopeRows(scope);
    const draft = applyTaskDraftPatch(createTaskDraft(before), nativeTaskDraftPatchValues(request));
    const updates = buildTaskEditUpdatePatch({ draft, checklist: before.checklist, attachments }, before);
    if (!updates) return null;
    if (request.attachments && !taskEditValuesEqual(before.attachments ?? [], attachments)) updates.attachments = attachments;
    for (const field of SCHEDULE) {
        if (own(request.patch, field)) Object.assign(updates, { [field]: draft[field] || undefined });
    }
    // The editor helper also tidies legacy checklist rows and inconsistent
    // containers. This writer owns only the requested fields and their shared
    // schedule/recurrence effects, not that unrelated cleanup.
    const requested = new Set<string>(Object.keys(request.patch));
    if (request.attachments) requested.add('attachments');
    if (SCHEDULE.some((field) => own(request.patch, field))) SCHEDULE.forEach((field) => requested.add(field));
    if (RECURRENCE.some((field) => own(request.patch, field))) RECURRENCE.forEach((field) => requested.add(field));
    if (ASSOCIATIONS.some((field) => own(request.patch, field))) ASSOCIATIONS.forEach((field) => requested.add(field));
    for (const field of Object.keys(updates)) {
        if (!requested.has(field)) delete (updates as Record<string, unknown>)[field];
    }
    if (!recurrenceRuleEdited(request)) delete updates.recurrence;
    if (!recurrenceFlagEdited(request) && !recurrenceRuleEdited(request)) delete updates.showFutureRecurrence;
    if (findTaskProjectReactivationTarget(before, updates, rows.projects)) return null;
    const moves = ASSOCIATIONS.some((field) => own(request.patch, field));
    const resolved = moves ? prepareTaskUpdatesForStore({ task: before, updates, allProjects: rows.projects,
        allSections: rows.sections, allAreas: rows.areas,
        nowMs: Date.parse(preparedAt),
        projectOrderReserver: () => scope.nextProjectOrder ?? undefined })
        : { ok: true as const, updates: normalizeTaskUpdate(before, updates, { nowMs: Date.parse(preparedAt) }) };
    if (!resolved.ok) return null;
    const applied = applyTaskUpdates(before, resolved.updates, preparedAt);
    if (applied.nextRecurringTask) return null;
    const dependent = SCHEDULE.some((field) => own(request.patch, field))
        || recurrenceRuleEdited(request) || recurrenceFlagEdited(request);
    const owned = new Set<string>(Object.keys(updates));
    if (dependent) ['status', 'startTime', 'dueDate', 'relativeStartOffset', 'reviewAt',
        'isFocusedToday', 'focusOrder', 'pushCount', 'boardOrder'].forEach((field) => owned.add(field));
    if (moves) ['projectId', 'sectionId', 'areaId', 'order', 'orderNum'].forEach((field) => owned.add(field));
    // The shared update computes dependent fields, but a title-only edit must
    // not copy its unrelated legacy lifecycle normalization into the raw row.
    const unstamped = { ...before } as Task;
    for (const field of owned) {
        const value = applied.updatedTask[field as keyof Task];
        if (value === undefined) delete (unstamped as unknown as Record<string, unknown>)[field];
        else (unstamped as unknown as Record<string, unknown>)[field] = value;
    }
    if (rawTaskEqual(before, unstamped)) return before;
    return { ...unstamped, updatedAt: preparedAt, rev: nextRevision(before.rev), revBy: deviceId };
};

export type NativeTaskDraftSaveDependencies = {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    validateField: (field: TaskDraftField, value: unknown) => boolean;
};
type TaskDraftAttachmentStrategy = {
    readRequest: (input: unknown) => NativeTaskDraftSaveRequest | null;
    mergeAttachments: typeof mergeNativeTaskLinkHalf;
    detachPrepared: (input: unknown) => unknown;
};

// Only factory code selects this strategy. Legacy contract entry points never
// accept a strategy, a caller permission flag, or a file-aware journal version.
function createTaskDraftSaveFactory(deps: NativeTaskDraftSaveDependencies, strategy?: TaskDraftAttachmentStrategy) {
    const mergeAttachments = strategy?.mergeAttachments ?? mergeNativeTaskLinkHalf;
    const patchValues = nativeTaskDraftPatchValues;
    const readRequest = (input: unknown, allowPlain = false, allowAttachments = false) => {
        if (strategy) return strategy.readRequest(input);
        const request = readNativeTaskDraftSaveRequest(input, deps.validateField, false, allowPlain, allowAttachments);
        // V1 was sealed before Location and Assigned To were offered. Checklist
        // has its own parser, but old prepared journal grammar must not widen.
        return request && (!allowPlain && (own(request.patch, 'location') || own(request.patch, 'assignedTo')) ? null : request);
    };
    const serializedDirect = serializeNativeTaskDraftDirect;
    const validBases = validNativeTaskDraftBases;
    const saves = createAreaSaveGuard(deps.save);

    /** Check semantic authority without rerunning calendar or clock-dependent effects. */
    const validPrepared = (prepared: NativePreparedTaskDraftSave, preserveRaw = false, allowAttachments = false): boolean => {
        const { before, changes, request } = prepared;
        if (before.id !== request.id || typeof before.title !== 'string' || typeof before.createdAt !== 'string'
            || typeof before.updatedAt !== 'string' || !['inbox', 'next', 'waiting', 'someday', 'done', 'archived',
                ...(preserveRaw ? ['reference'] : [])].includes(before.status)
            || before.deletedAt || before.purgedAt || !validBases(before, request, preserveRaw)) return false;
        if (Object.keys(changes).some((field) => !(STORED_FIELDS as readonly string[]).includes(field)
            && !EFFECTS.includes(field) && !(allowAttachments && field === 'attachments'))) return false;
        const after = applyPreparedTaskEditChanges(prepared);
        if (!taskEditValuesEqual(changes, buildPreparedTaskEditChanges(before, after))) return false;
        const direct = serializedDirect(before, request);
        if (!direct) return false;
        if (allowAttachments) {
            const attachments = request.attachments
                ? mergeAttachments(before.attachments ?? [], request.attachments) : before.attachments;
            if (attachments === null || !taskEditValuesEqual(after.attachments ?? [], attachments ?? [])) return false;
        }
        for (const field of FIELDS) {
            if (field === 'status') continue; // The older date route may induce status promotion, but cannot request it.
            if ((SCHEDULE as readonly string[]).includes(field) || (ASSOCIATIONS as readonly string[]).includes(field)
                || (RECURRENCE as readonly string[]).includes(field)) continue;
            if (own(changes, field) && !own(request.patch, field)) return false;
            if (own(request.patch, field) && !taskEditValuesEqual(after[field as keyof Task], direct[field as keyof Task])) return false;
        }
        // Match RN's narrowed recurrence write, preserving untouched legacy raw
        // values. Only the recurrence projection is normalized here; clock and
        // timezone-dependent schedule/focus effects remain frozen in changes.
        const recurrenceUpdates = request.recurrenceBase ? buildTaskEditUpdatePatch({
            draft: applyTaskDraftPatch(createTaskDraft(before), patchValues(request)),
            checklist: before.checklist, attachments: before.attachments,
        }, before) : null;
        const changesRecurrence = recurrenceUpdates && own(recurrenceUpdates, 'recurrence')
            && (!preserveRaw || recurrenceRuleEdited(request));
        const recurrence = changesRecurrence
            ? normalizeTaskUpdate(before, { recurrence: recurrenceUpdates.recurrence }).recurrence : before.recurrence;
        if (changesRecurrence && recurrence && (typeof recurrence !== 'object'
            || recurrence.seriesId !== (normalizeRecurrenceForLoad(before.recurrence)?.seriesId ?? before.id))) return false;
        const showFutureRecurrence = recurrenceUpdates && own(recurrenceUpdates, 'showFutureRecurrence')
            && (!preserveRaw || recurrenceFlagEdited(request) || recurrenceRuleEdited(request))
            ? recurrenceUpdates.showFutureRecurrence : before.showFutureRecurrence;
        if (!taskEditValuesEqual(after.recurrence, recurrence) || !taskEditValuesEqual(after.showFutureRecurrence, showFutureRecurrence)) return false;
        if (!validNativeTaskDraftScheduleEffect(before, request, after, deps.validateField)) return false;
        const moves = ASSOCIATIONS.some((field) => own(request.patch, field));
        const projectId = moves ? request.patch.projectId || undefined : before.projectId;
        const sectionId = moves ? (projectId ? request.patch.sectionId || undefined : undefined) : before.sectionId;
        const areaId = (preserveRaw ? moves && Boolean(projectId) : Boolean(projectId))
            ? undefined : moves ? request.patch.areaId || undefined : before.areaId;
        if (!taskEditValuesEqual(after.projectId, projectId) || !taskEditValuesEqual(after.sectionId, sectionId) || !taskEditValuesEqual(after.areaId, areaId)) return false;
        const promotes = before.status === 'inbox' && Boolean(after.startTime) && !taskEditValuesEqual(before.startTime, after.startTime);
        if (after.status !== (promotes ? 'next' : before.status)) return false;
        if (own(changes, 'isFocusedToday') && after.isFocusedToday !== false) return false;
        if (own(changes, 'focusOrder') && after.focusOrder !== undefined) return false;
        if (own(changes, 'boardOrder') && (after.boardOrder !== undefined || after.status === before.status)) return false;
        if (['done', 'archived'].includes(after.status) && (!preserveRaw || before.status !== after.status
            || SCHEDULE.some((field) => own(request.patch, field)) || RECURRENCE.some((field) => own(request.patch, field)))
            && (after.isFocusedToday !== false || after.focusOrder !== undefined)) return false;
        for (const field of ['order', 'orderNum'] as const) {
            if (!own(changes, field)) continue;
            if (taskEditValuesEqual(before.projectId, after.projectId) || (after.projectId
                ? typeof after[field] !== 'number' || !Number.isFinite(after[field]) || !taskEditValuesEqual(after.order, after.orderNum)
                : after[field] !== undefined)) return false;
        }
        if (own(changes, 'pushCount') && (!own(request.patch, 'dueDate') || after.pushCount !== (before.pushCount ?? 0) + 1)) return false;
        const cancelledAt = preserveRaw ? before.cancelledAt
            : after.status === 'archived' ? normalizeCancellationTimestamp(before.cancelledAt) : undefined;
        if (!taskEditValuesEqual(after.cancelledAt, cancelledAt)) return false;
        const completed = ['done', 'archived'].includes(after.status) && !cancelledAt;
        if (preserveRaw) {
            if (!taskEditValuesEqual(after.completedAt, before.completedAt)) return false;
        } else if (!completed ? after.completedAt !== undefined : before.completedAt
            ? after.completedAt !== before.completedAt : !after.completedAt || !deps.validateField('completedAt', after.completedAt)) return false;
        for (const field of ['statusBeforeProjectArchive', 'completedAtBeforeProjectArchive', 'isFocusedTodayBeforeProjectArchive', 'projectArchivedAt'] as const) {
            if (!taskEditValuesEqual(after[field], preserveRaw ? before[field] : before.projectArchivedAt ? undefined : before[field])) return false;
        }
        return true;
    };
    const readPrepared = (input: unknown): NativePreparedTaskDraftSave | null => {
        const value = detach(input, 2_000_000);
        if (!record(value) || !keys(value, ['version', 'request', 'before', 'changes']) || value.version !== 1
            || !record(value.before) || !record(value.changes)) return null;
        const request = readRequest(value.request);
        if (!request) return null;
        const prepared = { ...value, request } as unknown as NativePreparedTaskDraftSave;
        try {
            return validPrepared(prepared) ? prepared : null;
        } catch {
            // A journal is untrusted JSON; typed draft helpers may reject a
            // malformed raw before value by throwing. Refuse it without writes.
            return null;
        }
    };

    const readPreparedV2 = (input: unknown): NativePreparedTaskDraftSaveV2 | null => {
        const value = strategy ? strategy.detachPrepared(input) : detach(input, 2_000_000);
        if (!record(value) || !keys(value, ['version', 'request', 'preparedAt', 'deviceIdBefore',
            'deviceIdToInitialize', 'scope', 'effect']) || value.version !== 2
            || !record(value.scope) || !record(value.effect) || !keys(value.effect, ['task'])
            || !record(value.effect.task) || !keys(value.effect.task, ['before', 'after'])
            || !keys(value.scope, ['sourceProject', 'targetProject', 'targetSection', 'targetArea', 'nextProjectOrder'])) return null;
        const request = readRequest(value.request, true, true);
        if (!request || !iso(value.preparedAt)
            || !nullableText(value.deviceIdBefore) || !nullableText(value.deviceIdToInitialize)
            || (value.deviceIdBefore === null) === (value.deviceIdToInitialize === null)
            || !validRawTask(value.effect.task.before, request.id)
            || !validRawTask(value.effect.task.after, request.id)) return null;
        const scope = value.scope;
        if (scope.sourceProject !== null && !validProjectWitness(scope.sourceProject)
            || scope.targetProject !== null && !validProjectWitness(scope.targetProject)
            || scope.targetSection !== null && !validSectionWitness(scope.targetSection)
            || scope.targetArea !== null && !validAreaWitness(scope.targetArea)
            || scope.nextProjectOrder !== null && !(typeof scope.nextProjectOrder === 'number'
                && Number.isSafeInteger(scope.nextProjectOrder) && scope.nextProjectOrder >= 0)) return null;
        const before = value.effect.task.before, after = value.effect.task.after;
        if (scope.sourceProject && scope.targetProject && scope.sourceProject.id === scope.targetProject.id
            && !taskEditValuesEqual(scope.sourceProject, scope.targetProject)) return null;
        const moves = ASSOCIATIONS.some((field) => own(request.patch, field));
        const projectId = moves ? request.patch.projectId || undefined : before.projectId;
        const sectionId = moves ? request.patch.sectionId || undefined : before.sectionId;
        const areaId = moves ? request.patch.areaId || undefined : before.areaId;
        if (scope.sourceProject && scope.sourceProject.id !== before.projectId
            || moves && (scope.targetProject?.id !== projectId && !(scope.targetProject === null && !projectId)
                || scope.targetSection?.id !== sectionId && !(scope.targetSection === null && !sectionId)
                || scope.targetArea?.id !== areaId && !(scope.targetArea === null && !areaId)
                || sectionId && scope.targetSection?.projectId !== projectId)
            || !moves && (scope.targetProject !== null || scope.targetSection !== null || scope.targetArea !== null)
            || scope.nextProjectOrder !== null !== Boolean(moves && projectId && projectId !== before.projectId)
            || scope.nextProjectOrder !== null && (after.order !== scope.nextProjectOrder
                || after.orderNum !== scope.nextProjectOrder)
            || after.rev !== nextRevision(before.rev)
            || after.revBy !== (value.deviceIdBefore ?? value.deviceIdToInitialize)
            || after.updatedAt !== value.preparedAt || before.id !== after.id) return null;
        const changes = buildPreparedTaskEditChanges(before, after);
        if (Object.keys(changes).length === 0 || own(changes, 'deletedAt') || own(changes, 'purgedAt')) return null;
        const prepared = value as unknown as NativePreparedTaskDraftSaveV2;
        try {
            const scheduleEdited = SCHEDULE.some((field) => own(request.patch, field));
            const recurrenceEdited = RECURRENCE.some((field) => own(request.patch, field));
            const allowed = new Set<string>(Object.keys(request.patch).filter((field) =>
                field !== 'preserveChecklistOnRepeat' && field !== 'recurrenceStrategy' && field !== 'recurrenceRRule'));
            if (moves) ['projectId', 'areaId', 'sectionId', 'order', 'orderNum'].forEach((field) => allowed.add(field));
            if (scheduleEdited || recurrenceEdited) {
                ['startTime', 'relativeStartOffset', 'status', 'isFocusedToday', 'focusOrder', 'boardOrder'].forEach((field) => allowed.add(field));
            }
            if (own(request.patch, 'dueDate')) allowed.add('pushCount');
            if (request.attachments) allowed.add('attachments');
            const changedKeys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
                .filter((field) => !['rev', 'revBy', 'updatedAt'].includes(field)
                    && !sameSectionDeleteJson(before[field as keyof Task], after[field as keyof Task]));
            if (!changedKeys.every((field) => allowed.has(field))) return null;
            if (!scheduleEdited && !recurrenceEdited) {
                const exact = draftSaveEffect(before, request, scope as NativePreparedTaskDraftSaveV2['scope'],
                    value.preparedAt, value.deviceIdBefore ?? value.deviceIdToInitialize!, mergeAttachments);
                if (!exact || !rawTaskEqual(exact, after)) return null;
            }
            return (before.status !== 'reference' || referenceEditable(request))
                && validPrepared({ version: 1, request, before, changes }, true, true) ? prepared : null;
        } catch { return null; }
    };
    const readAnyPrepared = (input: unknown): NativePreparedTaskDraftSaveAny | null =>
        record(input) && input.version === 2 ? readPreparedV2(input) : readPrepared(input);

    const readNoop = (input: unknown, originalRequest: NativeTaskDraftSaveRequest): NativeOwnedTaskDraftNoopDecision | null => {
        if (!strategy) return null;
        const value = strategy.detachPrepared(input), request = readRequest(originalRequest, true, true);
        if (!request || !record(value) || !keys(value, ['kind', 'preparedAt', 'deviceIdBefore', 'scope', 'effect'])
            || value.kind !== 'noop' || !iso(value.preparedAt) || !nullableText(value.deviceIdBefore)
            || !record(value.scope) || !keys(value.scope, ['sourceProject', 'targetProject', 'targetSection', 'targetArea', 'nextProjectOrder'])
            || !record(value.effect) || !keys(value.effect, ['task']) || !record(value.effect.task)
            || !keys(value.effect.task, ['before', 'after']) || !validRawTask(value.effect.task.before, request.id)
            || !validRawTask(value.effect.task.after, request.id)) return null;
        const scope = value.scope;
        if (scope.sourceProject !== null && !validProjectWitness(scope.sourceProject)
            || scope.targetProject !== null && !validProjectWitness(scope.targetProject)
            || scope.targetSection !== null && !validSectionWitness(scope.targetSection)
            || scope.targetArea !== null && !validAreaWitness(scope.targetArea)
            || scope.nextProjectOrder !== null && !(typeof scope.nextProjectOrder === 'number'
                && Number.isSafeInteger(scope.nextProjectOrder) && scope.nextProjectOrder >= 0)) return null;
        const noop = value as unknown as NativeOwnedTaskDraftNoopDecision, before = noop.effect.task.before;
        try {
            if (before.deletedAt || before.purgedAt || before.status === 'reference' && !referenceEditable(request)
                || !rawTaskEqual(before, noop.effect.task.after)
                || !taskEditValuesEqual(draftSaveScope(before, request, { tasks: [before], ...scopeRows(noop.scope) }), noop.scope)) return null;
            // This transient calculation value never becomes a device witness or a write.
            const after = draftSaveEffect(before, request, noop.scope, noop.preparedAt,
                noop.deviceIdBefore ?? 'native-noop-calculation', mergeAttachments);
            return after && rawTaskEqual(before, after) ? noop : null;
        } catch { return null; }
    };

    const confirmNoop = async (noop: NativeOwnedTaskDraftNoopDecision, request: NativeTaskDraftSaveRequest):
        Promise<NativeHostResult<{ id: string; draft: TaskDraft }>> => {
        const ready = deps.readiness();
        if (!ready.ok) return ready;
        const captured = readNoop(noop, request);
        if (!captured) return fail('INVALID_INPUT', 'An exact frozen no-op decision is required');
        const generation = getPersistenceStatus().generation;
        const read = await readAreaDurableData(false, true);
        if (!read.ok) return read;
        const afterReady = deps.readiness();
        if (!afterReady.ok) return afterReady;
        const status = getPersistenceStatus(), state = useTaskStore.getState(), bound = read.value.authority.state;
        if (getStorageAdapter() !== read.value.adapter || status.generation !== generation
            || state._allTasks !== bound._allTasks || state._allProjects !== bound._allProjects
            || state._allSections !== bound._allSections || state._allAreas !== bound._allAreas
            || state._allPeople !== bound._allPeople || state.settings !== bound.settings || state.lastDataChangeAt !== bound.lastDataChangeAt)
            return fail('STALE_REVISION', 'Task data changed while confirming a no-op');
        if (state.persistenceFailure || status.queued || status.inFlight || status.immediate || status.retrying || status.failed)
            return fail('SAVE_FAILED', 'Task edit has unresolved persistence work');
        const data = read.value.authority.snapshot, matches = data.tasks.filter((row) => row.id === request.id);
        const current = matches.length === 1 ? matches[0] : null;
        if (!current || !rawTaskEqual(current, captured.effect.task.before)
            || (data.settings.deviceId ?? null) !== captured.deviceIdBefore
            || isStatusListTaskReadOnly(current, data.projects) || current.status === 'reference' && !referenceEditable(request)
            || !taskEditValuesEqual(draftSaveScope(current, request, data), captured.scope))
            return fail('STALE_REVISION', 'Task or destination changed while confirming a no-op');
        return { ok: true, value: taskResult(captured.effect.task.after) };
    };

    const commitV2 = async (prepared: NativePreparedTaskDraftSaveV2, identity: unknown = prepared):
        Promise<NativeHostResult<{ id: string; draft: TaskDraft }>> => {
        const ready = deps.readiness();
        if (!ready.ok) return ready;
        const request = prepared.request;
        const read = await readAreaDurableData(true, true);
        if (!read.ok) return read;
        if (!saves.mayApply(identity, read.value.adapter))
            return fail('SAVE_FAILED', 'Task edit has an unresolved persistence failure');
        const data = read.value.authority.snapshot;
        const currentRows = data.tasks.filter((row) => row.id === request.id);
        const current = currentRows.length === 1 ? currentRows[0] : null;
        if (!current) return fail('TASK_NOT_FOUND', 'Task not found or duplicated');
        const replayed = rawTaskEqual(current, prepared.effect.task.after)
            && (prepared.deviceIdToInitialize === null
                || (data.settings.deviceId ?? null) === prepared.deviceIdToInitialize);
        if (!replayed) {
            if (!rawTaskEqual(current, prepared.effect.task.before)
                || current.status === 'reference' && !referenceEditable(request)
                || isStatusListTaskReadOnly(current, data.projects)
                || !taskEditValuesEqual(draftSaveScope(current, request, data), prepared.scope))
                return fail('STALE_REVISION', 'Task or destination changed while editing');
            const selectedProject = prepared.scope.targetProject;
            if (selectedProject && !data.projects.some((project) => project.id === selectedProject.id
                && isSelectableProjectForTaskAssignment(project)))
                return fail('STALE_REVISION', 'Project is no longer available');
            if (prepared.scope.targetSection && !data.sections.some((section) => section.id === prepared.scope.targetSection?.id
                && section.projectId === prepared.scope.targetSection?.projectId && !section.deletedAt)
                || prepared.scope.targetArea && !data.areas.some((area) => area.id === prepared.scope.targetArea?.id
                    && !area.deletedAt)) return fail('STALE_REVISION', 'Destination is no longer available');
        }
        const applied = await useTaskStore.getState().commitPreparedTaskDraftV2(prepared, read.value.authority);
        if (!applied.success) return fail(applied.reason === 'missing' ? 'TASK_NOT_FOUND'
            : applied.reason === 'invalid' ? 'INVALID_INPUT' : 'STALE_REVISION', applied.error ?? 'Task changed while editing');
        const saved = await saves.finish(identity, read.value.adapter, applied.outcome === 'replayed', read.value.authority.saveBoundary);
        return saved.ok ? { ok: true, value: taskResult(prepared.effect.task.after) } : saved;
    };

    const prepareV2 = async (input: NativeTaskDraftSaveRequest, captureNoop?: (value: NativeOwnedTaskDraftNoopDecision) => void): Promise<NativeHostResult<
        { kind: 'noop'; result: { id: string; draft: TaskDraft } }
        | { kind: 'prepared'; prepared: NativePreparedTaskDraftSaveV2 }>> => {
        const ready = deps.readiness();
        if (!ready.ok) return ready;
        const request = readRequest(input, true, true);
        if (!request) return fail('INVALID_INPUT', 'A complete task draft and raw baselines are required');
        const read = await readAreaDurableData(false, true);
        if (!read.ok) return read;
        const data = read.value.authority.snapshot;
        const matches = data.tasks.filter((row) => row.id === request.id);
        const task = captureNoop ? (matches.length === 1 ? matches[0] : null) : matches[0];
        if (!task || task.deletedAt || task.purgedAt) return fail('TASK_NOT_FOUND', 'Task not found');
        if (isStatusListTaskReadOnly(task, data.projects)
            || task.status === 'reference' && !referenceEditable(request))
            return fail('INVALID_INPUT', 'Task is not editable');
        if (!validBases(task, request, true)) return fail('STALE_REVISION', 'Task changed while editing');
        if (own(request.patch, 'projectId') && request.patch.projectId
            && !data.projects.some((project) => project.id === request.patch.projectId && isSelectableProjectForTaskAssignment(project))) {
            return fail('INVALID_INPUT', 'Project is not available');
        }
        if (request.patch.areaId && !data.areas.some((area) => area.id === request.patch.areaId && !area.deletedAt)) {
            return fail('INVALID_INPUT', 'Area is not available');
        }
        if (request.patch.sectionId && !data.sections.some((section) => section.id === request.patch.sectionId
            && section.projectId === request.patch.projectId && !section.deletedAt)) {
            return fail('INVALID_INPUT', 'Section is not available');
        }
        const preparedAt = new Date().toISOString();
        const scope = draftSaveScope(task, request, data);
        let device = captureNoop ? { deviceId: data.settings.deviceId ?? 'native-noop-calculation', updated: !data.settings.deviceId }
            : ensureDeviceId(data.settings);
        let after = draftSaveEffect(task, request, scope, preparedAt, device.deviceId, mergeAttachments);
        if (!after) return fail('INVALID_INPUT', 'Task edit cannot produce a valid prepared journal');
        if (rawTaskEqual(task, after)) {
            if (captureNoop) captureNoop({ kind: 'noop', preparedAt, deviceIdBefore: data.settings.deviceId ?? null,
                scope, effect: { task: { before: JSON.parse(JSON.stringify(task)) as Task, after: JSON.parse(JSON.stringify(task)) as Task } } });
            return { ok: true, value: { kind: 'noop', result: taskResult(task) } };
        }
        if (captureNoop && device.updated) {
            device = ensureDeviceId(data.settings);
            after = draftSaveEffect(task, request, scope, preparedAt, device.deviceId, mergeAttachments);
            if (!after) return fail('INVALID_INPUT', 'Task edit cannot produce a valid prepared journal');
        }
        const before = JSON.parse(JSON.stringify(task)) as Task;
        const frozenAfter = JSON.parse(JSON.stringify(after)) as Task;
        const prepared = readPreparedV2({ version: 2, request, preparedAt,
            deviceIdBefore: data.settings.deviceId ?? null,
            deviceIdToInitialize: device.updated ? device.deviceId : null,
            scope, effect: { task: { before, after: frozenAfter } } });
        return prepared ? { ok: true, value: { kind: 'prepared', prepared } }
            : fail('INVALID_INPUT', 'Task edit cannot produce a valid prepared journal');
    };

    const methods = {
        /** Legacy v1 date/recurrence preparation remains strict for old callers and journals. */
        prepareTaskDraftSave(input: NativeTaskDraftSaveRequest): NativeHostResult<NativePreparedTaskDraftSave> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A complete date or recurrence save request and raw baselines are required');
            const state = useTaskStore.getState();
            const task = state._tasksById.get(request.id);
            if (!task || task.deletedAt || task.purgedAt) return fail('TASK_NOT_FOUND', 'Task not found');
            if (task.status === 'reference' || isStatusListTaskReadOnly(task, state._allProjects)) return fail('INVALID_INPUT', 'Task is not editable');
            if (!validBases(task, request)) return fail('STALE_REVISION', 'Task changed while editing');
            if (own(request.patch, 'projectId') && request.patch.projectId
                && !state._allProjects.some((project) => project.id === request.patch.projectId && isSelectableProjectForTaskAssignment(project))) {
                return fail('INVALID_INPUT', 'Project is not available');
            }
            if (request.patch.areaId && !state._allAreas.some((area) => area.id === request.patch.areaId && !area.deletedAt)) {
                return fail('INVALID_INPUT', 'Area is not available');
            }
            if (request.patch.sectionId && !state._allSections.some((section) => section.id === request.patch.sectionId
                && section.projectId === request.patch.projectId && !section.deletedAt)) {
                return fail('INVALID_INPUT', 'Section is not available');
            }
            const draft = applyTaskDraftPatch(createTaskDraft(task), patchValues(request));
            const updates = buildTaskEditUpdatePatch({ draft, checklist: task.checklist, attachments: task.attachments }, task);
            if (!updates) return fail('INVALID_INPUT', 'title must not be blank');
            for (const field of SCHEDULE) {
                if (own(request.patch, field)) Object.assign(updates, { [field]: draft[field] || undefined });
            }
            if (findTaskProjectReactivationTarget(task, updates, state._allProjects)) return fail('INVALID_INPUT', 'Project reactivation is outside this edit');
            const resolved = prepareTaskUpdatesForStore({ task, updates, allProjects: state._allProjects,
                allSections: state._allSections, allAreas: state._allAreas, settings: state.settings,
                projectOrderReserver: createProjectOrderReserver(state._allTasks) });
            if (!resolved.ok) return fail('INVALID_INPUT', resolved.error);
            const applied = applyTaskUpdates(task, resolved.updates, new Date().toISOString());
            if (applied.nextRecurringTask) return fail('INVALID_INPUT', 'Recurring task creation is outside this edit');
            const before = JSON.parse(JSON.stringify(task)) as Task;
            const prepared = readPrepared({ version: 1, request, before, changes: buildPreparedTaskEditChanges(before, applied.updatedTask) });
            return prepared ? { ok: true, value: prepared } : fail('INVALID_INPUT', 'Task edit cannot produce a valid prepared journal');
        },

        prepareTaskDraftSaveV2(input: NativeTaskDraftSaveRequest) {
            return prepareV2(input);
        },

        validatePreparedTaskDraftSave(input: { request: NativeTaskDraftSaveRequest; prepared: NativePreparedTaskDraftSaveAny }):
            NativeHostResult<{ version: 1; id: string } | { version: 2; result: { id: string; draft: TaskDraft } }> {
            if (!record(input) || !keys(input, ['request', 'prepared']))
                return fail('INVALID_INPUT', 'A prepared task edit is required');
            const prepared = readAnyPrepared(input.prepared);
            const request = readRequest(input.request, prepared?.version === 2, prepared?.version === 2);
            if (!request || !prepared || !taskEditValuesEqual(request, prepared.request))
                return fail('INVALID_INPUT', 'Prepared task edit request or journal does not match');
            return prepared.version === 2
                ? { ok: true, value: { version: 2, result: taskResult(prepared.effect.task.after) } }
                : { ok: true, value: { version: 1, id: request.id } };
        },

        async commitPreparedTaskDraftSave(input: { request: NativeTaskDraftSaveRequest; prepared: NativePreparedTaskDraftSaveAny }): Promise<NativeHostResult<{ id: string; draft: TaskDraft }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!record(input) || !keys(input, ['request', 'prepared'])) return fail('INVALID_INPUT', 'A prepared task edit is required');
            const prepared = readAnyPrepared(input.prepared);
            const request = readRequest(input.request, prepared?.version === 2, prepared?.version === 2);
            if (!request || !prepared || !taskEditValuesEqual(request, prepared.request)) return fail('INVALID_INPUT', 'Prepared task edit request or journal does not match');
            if (prepared.version === 2) {
                return commitV2(prepared);
            }
            const result = await useTaskStore.getState().commitPreparedTaskEdit(prepared);
            if (!result.success) return fail(result.reason === 'missing' ? 'TASK_NOT_FOUND' : result.reason === 'conflict' ? 'STALE_REVISION' : 'INVALID_INPUT', result.error ?? 'Prepared task edit refused');
            try {
                if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            } catch (error) {
                return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error));
            }
            const saved = await deps.save();
            if (!saved.ok) return saved;
            const task = useTaskStore.getState()._tasksById.get(request.id);
            if (!task) return fail('TASK_NOT_FOUND', 'Task not found');
            try {
                logInfo(request.recurrenceBase ? 'Native prepared recurrence save result' : 'Native prepared date save result', {
                    scope: 'native-host', category: 'storage', context: {
                        releaseCheck: request.recurrenceBase ? 'v1.3.3/native-prepared-recurrence-save' : 'v1.3.3/native-prepared-date-save',
                        outcome: result.outcome,
                    },
                });
            } catch { /* Diagnostics cannot invalidate a durable acknowledgment. */ }
            return { ok: true, value: { id: request.id, draft: createTaskDraft(task) } };
        },
    };
    const publicMethods = {
        ...methods,
        /** Reuse the exact Task Draft V2 journal for one Review row's saved Task action. */
        async prepareReviewTaskWrite(input: NativeReviewTaskWriteInput): Promise<NativeHostResult<
            { kind: 'noop'; result: { id: string; draft: TaskDraft } }
            | { kind: 'prepared'; prepared: NativePreparedTaskDraftSaveV2 }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const detached = detach(input, 4_096);
            if (!record(detached) || !keys(detached, ['type', 'taskId', 'advance', 'taskRevision'])
                || detached.type !== 'markTaskReviewed'
                || typeof detached.taskId !== 'string' || !detached.taskId.trim() || detached.taskId.length > 500
                || typeof detached.advance !== 'boolean'
                || typeof detached.taskRevision !== 'string' || !detached.taskRevision
                || detached.taskRevision.length > 200) {
                return fail('INVALID_INPUT', 'A task, advance true or false, and the task revision the row showed are required');
            }
            const action = detached as NativeReviewTaskWriteInput;
            const read = await readAreaDurableData(false, true);
            if (!read.ok) return read;
            const task = read.value.authority.snapshot.tasks.find((row) => row.id === action.taskId);
            if (!task || task.deletedAt || task.purgedAt) return fail('TASK_NOT_FOUND', 'Task not found');
            const now = new Date();
            if (!isTaskDueForReview(task, now)) return { ok: true, value: { kind: 'noop', result: taskResult(task) } };
            if (taskRevisionOf(task) !== action.taskRevision) return fail('STALE_REVISION', 'Task changed since the Review row was shown');
            const request: NativeTaskDraftSaveRequest = {
                id: task.id,
                base: { reviewAt: createTaskDraft(task).reviewAt },
                patch: { reviewAt: action.advance ? getAdvancedReviewDate(task.reviewAt, now) : '' },
                scheduleBase: getNativeTaskScheduleBase(task),
            };
            const prepared = await methods.prepareTaskDraftSaveV2(request);
            if (!prepared.ok) return prepared;
            if (prepared.value.kind !== 'prepared'
                || taskRevisionOf(prepared.value.prepared.effect.task.before) !== action.taskRevision)
                return fail('STALE_REVISION', 'Task changed since the Review row was shown');
            return prepared;
        },
    };
    return { publicMethods, authority: { prepare: methods.prepareTaskDraftSaveV2, readPrepared: readPreparedV2, commit: commitV2,
        readNoop, confirmNoop,
        async prepareDecision(input: NativeTaskDraftSaveRequest): Promise<NativeHostResult<
            { kind: 'changed'; prepared: NativePreparedTaskDraftSaveV2 } | NativeOwnedTaskDraftNoopDecision>> {
            if (!strategy) return fail('INVALID_INPUT', 'A selected owned-file authority is required');
            let noop: NativeOwnedTaskDraftNoopDecision | null = null;
            const result = await prepareV2(input, (value) => { noop = value; });
            if (!result.ok) return result;
            if (result.value.kind === 'prepared') return { ok: true, value: { kind: 'changed', prepared: result.value.prepared } };
            const checked = readNoop(noop, input);
            return checked ? { ok: true, value: checked } : fail('INVALID_INPUT', 'A valid frozen no-op is required');
        },
    } };
}

export function createTaskDraftSaveMethods(deps: NativeTaskDraftSaveDependencies) {
    return createTaskDraftSaveFactory(deps).publicMethods;
}

/** Internal factory seam: no legacy contract method can select file authority. */
export function createOwnedFileTaskDraftSaveAuthority(deps: NativeTaskDraftSaveDependencies, strategy: TaskDraftAttachmentStrategy) {
    return createTaskDraftSaveFactory(deps, strategy).authority;
}
