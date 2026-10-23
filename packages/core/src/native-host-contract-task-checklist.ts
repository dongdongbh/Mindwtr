import type { NativeHostResult } from './native-host-contract';
import { getPersistenceStatus, getStorageAdapter, useTaskStore } from './store';
import type { PreparedAreaAuthority, PreparedChecklistEffect, PreparedChecklistRawBefore, PreparedNativeSaveBoundary, TaskStore } from './store-types';
import type { AppData, Area, ChecklistItem, Project, Section, Task } from './types';
import type { TaskDraftField } from './task-draft';
import { createTaskDraft } from './task-draft';
import { applyTaskDraftPatch, buildTaskEditUpdatePatch, getTaskEditorBackdatedCompletionStart,
    resolveTaskEditorBackdatedCompletion } from './task-editor-model';
import {
    nativeTaskDraftPatchValues, readNativeTaskDraftSaveRequest,
    getNativeTaskScheduleBase, validNativeTaskDraftBases, validNativeTaskDraftScheduleEffect, validRawTask, type NativeTaskDraftSaveRequest,
} from './native-host-contract-task-save';
import { isNativeJsonWithinBytes, readChecklist, toChecklist } from './native-host-contract-task-view';
import { buildResetTaskChecklistUpdates, planTaskUpdateEffects, prepareTaskUpdatesForStore,
    planSkippedRecurringOccurrence, planTaskMutations, samePreparedTask, taskEditValuesEqual } from './store-tasks';
import { createProjectOrderReserver, ensureDeviceId, getNextProjectOrder, getTaskOrder,
    nextRevision } from './store-helpers';
import { createNativeRequestReceipts, taskRevisionOf, type NativeRequestReceipts } from './native-request-receipts';
import { compareAreasByOrder, countFocusedTasksBeforeBoundary } from './task-utils';
import { normalizeFocusTaskLimit } from './focus-utils';
import { getProjectChoiceState, isSelectableProjectForTaskAssignment } from './project-utils';
import { buildTaskMovePatch, type TaskMoveDestination } from './task-container-rules';
import { isStatusListTaskReadOnly } from './menu-views-model';
import { mergeNativeTaskLinkHalf, readNativeAttachments, type NativeTaskLinkHalf } from './native-host-contract-attachments';
import { mergeTaskDraftAttachments } from './attachment-editor-model';
import { canSkipRecurringTaskOccurrence, matchesAdvanceOneCalendarProjection,
    projectNextRecurringTask, type RecurrenceProjection } from './recurrence';
import { generateUUID } from './uuid';
import { getTranslator, resolveI18nText } from './i18n';
import { isTaskActionable, isTaskCancelled, normalizeTaskForLoad, type TaskLoadTemporalContext } from './task-status';
import { normalizeProjectLifecycleFields } from './project-status';
import { mapSqliteTaskRow, rawReadTaskSnapshot, TASK_SQLITE_COLUMNS, taskToSqliteRow } from './sqlite-adapter';
import { rememberRawReadRow } from './sqlite-raw-snapshot';
import { sameSectionDeleteJson, sameTaskSqliteRow } from './store-projects/section-actions';
import { createAreaSaveGuard, readAreaDurableData } from './native-host-contract-area-durable';
import { isProjectedRecurringTaskId } from './recurrence';
import { taskCancellationRestoreFields } from './undo-task-cancellation';
import { formatTaskMarkedDoneMessage } from './undo-task-completion';
import { logInfo } from './logger';
import { isTaskEditorTimeSpentEnabled } from './task-editor-schedule';
import { normalizeTimeSpentMinutes } from './time-spent';

export type NativeChecklistSaveRequest = NativeTaskDraftSaveRequest & {
    requestId: string;
    checklist: { base: ChecklistItem[]; value: ChecklistItem[] };
    intent?: 'cancel' | 'skip' | 'doneStatus' | 'referenceNext' | 'referenceStatus' | 'referenceComplete' | 'referenceBackdate' | 'referenceDestination' | 'doneCompletedAt' | 'archiveCompletedAt';
};
export type NativeChecklistResetRequest = { id: string; requestId: string; checklistBase: ChecklistItem[] };
export type NativeChecklistWriteRequest = NativeChecklistSaveRequest | NativeChecklistResetRequest;
export type NativeChecklistResult = { id: string } | {
    id: string; cancellation: { cancelledAt: string; undoEnabled: boolean; message: string; undoLabel: string };
} | {
    id: string; checklistBase: ChecklistItem[]; status: Task['status']; completedAt: string | null; isFocusedToday: boolean;
};
type Lists = { tasks: Task[]; projects: Project[]; sections: Section[]; areas: Area[] };
type Witness = {
    source: Task;
    lists: Lists;
    settings: AppData['settings'];
    preparedAt: string;
    preparedLocalDay: string;
    preparedOffsetMinutes: number;
    boundaryOffsetMinutes: number;
    futureBoundary: string;
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    recurrenceProjection: RecurrenceProjection | null;
    calendarTimeZone?: string;
    ids: string[];
    /** Undefined top-level direct update fields are explicit clears. */
    directClears: string[];
    direct: Partial<Task>;
    focusCount: number;
    focusLimit: number;
    cancelMessage?: string;
    cancelUndoLabel?: string;
};
export type NativePreparedChecklistWrite = {
    version: 1;
    kind: 'save' | 'reset';
    request: NativeChecklistWriteRequest;
    witness: Witness;
    effect: PreparedChecklistEffect;
    result: NativeChecklistResult;
};
export type NativeChecklistPreparation = { kind: 'prepared'; prepared: NativePreparedChecklistWrite }
    | { kind: 'unchanged'; result: NativeChecklistResult };
export type NativeOwnedCompleteChecklistSaveRequest = Omit<NativeChecklistSaveRequest, 'intent' | 'attachments'> & {
    attachments: NativeTaskLinkHalf; intent?: 'cancel' | 'skip';
};
export type NativePreparedOwnedCompleteChecklistSave = Omit<NativePreparedChecklistWrite, 'version' | 'kind' | 'request'> & {
    version: 2; kind: 'save'; request: NativeOwnedCompleteChecklistSaveRequest; rawBefore: PreparedChecklistRawBefore;
};
export type NativeOwnedCompleteChecklistNoop = {
    version: 2; kind: 'noop'; request: NativeOwnedCompleteChecklistSaveRequest;
    witness: Witness; rawBefore: Task; result: { id: string };
};
export type NativeOwnedCompleteChecklistDecision = { kind: 'changed'; prepared: NativePreparedOwnedCompleteChecklistSave }
    | { kind: 'noop'; prepared: NativeOwnedCompleteChecklistNoop };
type OwnedChecklistProof = NativePreparedOwnedCompleteChecklistSave | NativeOwnedCompleteChecklistNoop;
export type NativeChecklistCancellationEnvelope = {
    request: NativeChecklistSaveRequest & { intent: 'cancel' };
    prepared: NativePreparedChecklistWrite;
};
export type NativeTaskCancellationUndoRequest = { requestId: string; cancelRequestId: string };
export type NativePreparedTaskCancellationUndo = {
    version: 1; kind: 'undo'; request: NativeTaskCancellationUndoRequest;
    cancel: NativeChecklistCancellationEnvelope;
    witness: Witness; effect: PreparedChecklistEffect; result: { id: string };
};
export type NativeTaskCancellationUndoEnvelope = {
    request: NativeTaskCancellationUndoRequest; prepared: NativePreparedTaskCancellationUndo;
};
export type NativeOwnedCompleteChecklistCancellation = {
    request: NativeOwnedCompleteChecklistSaveRequest & { intent: 'cancel' };
    prepared: NativePreparedOwnedCompleteChecklistSave;
};
export type NativePreparedOwnedCompleteCancellationUndo = Omit<NativePreparedTaskCancellationUndo, 'version' | 'cancel'> & {
    version: 2; cancel: unknown; rawBefore: PreparedChecklistRawBefore;
};
export type NativeOwnedCompleteCancellationUndoEnvelope = {
    request: NativeTaskCancellationUndoRequest; prepared: NativePreparedOwnedCompleteCancellationUndo;
};
export type NativeTaskCompletionRequest = { id: string; requestId: string; taskRevision: string; source?: 'reference' | 'board' };
type NativeBoardTaskCompletionRequest = NativeTaskCompletionRequest & { source: 'board' };
type NativeReferenceTaskCompletionRequest = NativeTaskCompletionRequest & { source: 'reference' };
export type NativeTaskCompletionResult = { id: string; completion: {
    completedAt: string; undoEnabled: boolean; message: string; undoLabel: string;
} };
type NativePreparedOrdinaryTaskCompletion = {
    version: 1; kind: 'complete'; request: NativeTaskCompletionRequest;
    checklist: NativePreparedChecklistWrite;
    notice: { message: string; undoLabel: string };
    result: NativeTaskCompletionResult;
};
export type NativePreparedTaskCompletion = NativePreparedOrdinaryTaskCompletion | {
    version: 2; kind: 'referenceComplete'; request: NativeReferenceTaskCompletionRequest;
    rawBefore: PreparedChecklistRawBefore; checklist: NativePreparedChecklistWrite;
    notice: { message: string; undoLabel: string }; result: NativeTaskCompletionResult;
} | {
    version: 2; kind: 'boardComplete'; request: NativeBoardTaskCompletionRequest;
    rawBefore: PreparedChecklistRawBefore; checklist: NativePreparedChecklistWrite;
    notice: { message: string; undoLabel: string }; result: NativeTaskCompletionResult;
};
export type NativeTaskCompletionEnvelope = {
    request: NativeTaskCompletionRequest; prepared: NativePreparedTaskCompletion;
};
export type NativeTaskCompletionUndoRequest = { requestId: string; completionRequestId: string };
type NativePreparedOrdinaryTaskCompletionUndo = {
    version: 1; kind: 'undo'; request: NativeTaskCompletionUndoRequest;
    completion: NativeTaskCompletionEnvelope;
    witness: Witness; effect: PreparedChecklistEffect; result: { id: string };
};
export type NativePreparedTaskCompletionUndo = NativePreparedOrdinaryTaskCompletionUndo | {
    version: 2; kind: 'referenceCompleteUndo'; request: NativeTaskCompletionUndoRequest;
    completion: NativeTaskCompletionEnvelope; rawBefore: PreparedChecklistRawBefore;
    witness: Witness; effect: PreparedChecklistEffect; result: { id: string };
} | {
    version: 2; kind: 'boardCompleteUndo'; request: NativeTaskCompletionUndoRequest;
    completion: NativeTaskCompletionEnvelope; rawBefore: PreparedChecklistRawBefore;
    witness: Witness; effect: PreparedChecklistEffect; result: { id: string };
};
export type NativeTaskCompletionUndoEnvelope = {
    request: NativeTaskCompletionUndoRequest; prepared: NativePreparedTaskCompletionUndo;
};
export type NativeReferenceTaskBackdateRequest = NativeReferenceTaskCompletionRequest & {
    completedAt: string; timeSpentText: string | null;
};
export type NativePreparedReferenceTaskBackdate = {
    version: 2; kind: 'referenceBackdate'; request: NativeReferenceTaskBackdateRequest;
    rawBefore: PreparedChecklistRawBefore; checklist: NativePreparedChecklistWrite; result: { id: string };
};
export type NativeReferenceTaskBackdateEnvelope = {
    request: NativeReferenceTaskBackdateRequest; prepared: NativePreparedReferenceTaskBackdate;
};
export type NativeReferenceTaskDestinationRequest = NativeReferenceTaskCompletionRequest & { destination: TaskMoveDestination };
export type NativePreparedReferenceTaskDestination = {
    version: 2; kind: 'referenceDestination'; request: NativeReferenceTaskDestinationRequest;
    rawBefore: PreparedChecklistRawBefore; checklist: NativePreparedChecklistWrite; result: { id: string };
};
export type NativeReferenceTaskDestinationEnvelope = {
    request: NativeReferenceTaskDestinationRequest; prepared: NativePreparedReferenceTaskDestination;
};
export type NativeReferenceTaskDestinationOptionsInput = {
    id: string; taskRevision: string; query: string; offset: number; limit: number;
};
export type NativeReferenceTaskDestinationOptions = NativeReferenceTaskDestinationOptionsInput & {
    version: 1; total: number; hasMore: boolean; nextOffset: number | null;
    choices: Array<{ kind: TaskMoveDestination['kind']; id: string; label: string; selected: boolean }>;
    labels: { title: string; search: string; projects: string; areas: string; cancel: string; more: string; retry: string; noMatches: string };
};
export type NativeDoneTaskStatus = 'inbox' | 'next' | 'waiting' | 'someday' | 'done' | 'reference';
type NativeUntaggedDoneTaskStatusRequest = NativeTaskCompletionRequest & { status: NativeDoneTaskStatus; source?: never };
type NativeReferenceTaskNextRequest = NativeTaskCompletionRequest & { status: 'next'; source: 'reference' };
type NativeReferenceTaskStatusRequest = NativeTaskCompletionRequest & { source: 'reference'; status: 'inbox' | 'waiting' | 'someday' | 'reference' };
export type NativeDoneTaskStatusRequest = NativeUntaggedDoneTaskStatusRequest | NativeReferenceTaskNextRequest | NativeReferenceTaskStatusRequest;
type NativePreparedDoneTaskStatusBase = {
    kind: 'doneStatus'; request: NativeUntaggedDoneTaskStatusRequest;
    checklist: NativePreparedChecklistWrite; result: { id: string };
};
export type NativePreparedDoneTaskStatus = (NativePreparedDoneTaskStatusBase & (
    { version: 1 } | { version: 2; rawBefore: Task }
)) | { version: 2; kind: 'referenceNext'; request: NativeReferenceTaskNextRequest;
    rawBefore: Task; checklist: NativePreparedChecklistWrite; result: { id: string } }
    | { version: 2; kind: 'referenceStatus'; request: NativeReferenceTaskStatusRequest;
        rawBeforeTask: Task; checklist: NativePreparedChecklistWrite; result: { id: string } };
export type NativeDoneTaskStatusEnvelope = {
    request: NativeDoneTaskStatusRequest; prepared: NativePreparedDoneTaskStatus;
};
export type NativeDoneTaskCompletedAtRequest = NativeTaskCompletionRequest & { completedAt: string };
export type NativePreparedDoneTaskCompletedAt = {
    version: 2; kind: 'doneCompletedAt'; request: NativeDoneTaskCompletedAtRequest;
    rawBefore: Task; checklist: NativePreparedChecklistWrite; result: { id: string };
};
export type NativeDoneTaskCompletedAtEnvelope = {
    request: NativeDoneTaskCompletedAtRequest; prepared: NativePreparedDoneTaskCompletedAt;
};
export type NativeArchiveTaskCompletedAtRequest = NativeTaskCompletionRequest & { completedAt: string };
export type NativePreparedArchiveTaskCompletedAt = {
    version: 2; kind: 'archiveCompletedAt'; request: NativeArchiveTaskCompletedAtRequest;
    rawBefore: Task; checklist: NativePreparedChecklistWrite; result: { id: string };
};
export type NativeArchiveTaskCompletedAtEnvelope = {
    request: NativeArchiveTaskCompletedAtRequest; prepared: NativePreparedArchiveTaskCompletedAt;
};
type NativeHistoryRowEnvelope = NativeDoneTaskStatusEnvelope | NativeDoneTaskCompletedAtEnvelope | NativeArchiveTaskCompletedAtEnvelope;
type NativeBoundHistoryRowEnvelope = (NativeDoneTaskStatusEnvelope & {
    prepared: NativePreparedDoneTaskStatus & { version: 2 } }) | NativeDoneTaskCompletedAtEnvelope | NativeArchiveTaskCompletedAtEnvelope;

type NativeRawReferenceEnvelope = (NativeTaskCompletionEnvelope & { prepared: NativePreparedTaskCompletion & { version: 2 } })
    | (NativeTaskCompletionUndoEnvelope & { prepared: NativePreparedTaskCompletionUndo & { version: 2 } })
    | NativeReferenceTaskBackdateEnvelope | NativeReferenceTaskDestinationEnvelope;
type NativeRawWriteEnvelope = NativeBoundHistoryRowEnvelope | NativeRawReferenceEnvelope;

const LIMIT_BYTES = 2_000_000;
const COMPLETION_BYTES = 2_100_000;
const COMPLETION_UNDO_BYTES = 4_500_000;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const DONE_STATUS_OPTIONS: readonly NativeDoneTaskStatus[] = ['inbox', 'next', 'waiting', 'someday', 'done', 'reference'];
const validCancelText = (value: unknown, maxLength: number): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= maxLength
    && value.trim() === value && Array.from(value).every((char) => {
        const code = char.charCodeAt(0);
        return code >= 32 && code !== 127;
    });
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const exact = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => own(value, key));
const same = taskEditValuesEqual;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'TASK_NOT_FOUND' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });

const detach = <T>(value: T, limit = LIMIT_BYTES): T | null => {
    const safe = (item: unknown, depth: number): boolean => {
        if (depth > 30) return false;
        if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
        if (typeof item === 'number') return Number.isFinite(item);
        if (Array.isArray(item)) return item.length <= limit && item.every((entry) => safe(entry, depth + 1));
        return isRecord(item) && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)
            && Object.keys(item).length <= 256 && Object.entries(item).every(([key, entry]) =>
                !['__proto__', 'prototype', 'constructor'].includes(key) && safe(entry, depth + 1));
    };
    if (!safe(value, 0)) return null;
    const encoded = JSON.stringify(value);
    return isNativeJsonWithinBytes(value, limit) ? JSON.parse(encoded) as T : null;
};
const canonicalJSON = (input: unknown): string => JSON.stringify(input, (_name, value) =>
    isRecord(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
const isSave = (value: NativeChecklistWriteRequest): value is NativeChecklistSaveRequest => 'checklist' in value;
const readUndoRequest = (value: unknown): NativeTaskCancellationUndoRequest | null => {
    const input = detach(value);
    return isRecord(input) && exact(input, ['requestId', 'cancelRequestId'])
        && typeof input.requestId === 'string' && UUID.test(input.requestId)
        && typeof input.cancelRequestId === 'string' && UUID.test(input.cancelRequestId)
        && input.requestId !== input.cancelRequestId ? input as NativeTaskCancellationUndoRequest : null;
};
const readCompletionRequest = (value: unknown): NativeTaskCompletionRequest | null => {
    const input = detach(value);
    return isRecord(input) && exact(input, ['id', 'requestId', 'taskRevision'])
        && typeof input.id === 'string' && Boolean(input.id.trim()) && input.id.length <= 500
        && typeof input.requestId === 'string' && UUID.test(input.requestId)
        && typeof input.taskRevision === 'string' && Boolean(input.taskRevision)
        && input.taskRevision.length <= 200 ? input as NativeTaskCompletionRequest : null;
};
const readDoneStatusRequest = (value: unknown): NativeDoneTaskStatusRequest | null => {
    const input = detach(value);
    if (!isRecord(input)) return null;
    if (own(input, 'source')) {
        if (!exact(input, ['id', 'requestId', 'taskRevision', 'status', 'source'])
            || input.source !== 'reference' || !['inbox', 'next', 'waiting', 'someday', 'reference'].includes(input.status as string)) return null;
        const request = readCompletionRequest({ id: input.id, requestId: input.requestId, taskRevision: input.taskRevision });
        return request ? { ...request, status: input.status as NativeReferenceTaskNextRequest['status'] | NativeReferenceTaskStatusRequest['status'], source: 'reference' } : null;
    }
    if (!exact(input, ['id', 'requestId', 'taskRevision', 'status'])
        || !DONE_STATUS_OPTIONS.includes(input.status as NativeDoneTaskStatus)) return null;
    const request = readCompletionRequest({ id: input.id, requestId: input.requestId, taskRevision: input.taskRevision });
    return request ? { id: request.id, requestId: request.requestId, taskRevision: request.taskRevision, status: input.status as NativeDoneTaskStatus } : null;
};
const isReferenceNextStatusRequest = (request: NativeTaskCompletionRequest): request is NativeReferenceTaskNextRequest =>
    'source' in request && request.source === 'reference' && 'status' in request && request.status === 'next';
const readReferenceCompletionRequest = (value: unknown): NativeReferenceTaskCompletionRequest | null => {
    const input = detach(value);
    if (!isRecord(input) || !exact(input, ['id', 'requestId', 'taskRevision', 'source']) || input.source !== 'reference') return null;
    const base = readCompletionRequest({ id: input.id, requestId: input.requestId, taskRevision: input.taskRevision });
    return base ? { ...base, source: 'reference' } : null;
};
const readBoardCompletionRequest = (value: unknown): NativeBoardTaskCompletionRequest | null => {
    const input = detach(value, 4096);
    if (!isRecord(input) || !exact(input, ['id', 'requestId', 'taskRevision', 'source']) || input.source !== 'board') return null;
    const base = readCompletionRequest({ id: input.id, requestId: input.requestId, taskRevision: input.taskRevision });
    return base ? { ...base, source: 'board' } : null;
};
const readReferenceBackdateRequest = (value: unknown): NativeReferenceTaskBackdateRequest | null => {
    const input = detach(value, 4096);
    if (!isRecord(input) || !exact(input, ['id', 'requestId', 'taskRevision', 'source', 'completedAt', 'timeSpentText'])
        || input.source !== 'reference' || typeof input.completedAt !== 'string' || input.completedAt.length > 200
        || !(input.timeSpentText === null || typeof input.timeSpentText === 'string' && input.timeSpentText.length <= 200)
        || !resolveTaskEditorBackdatedCompletion({ completedAt: input.completedAt,
            ...(input.timeSpentText !== null ? { timeSpentText: input.timeSpentText as string } : {}) })) return null;
    const base = readCompletionRequest({ id: input.id, requestId: input.requestId, taskRevision: input.taskRevision });
    return base ? { ...base, source: 'reference', completedAt: input.completedAt, timeSpentText: input.timeSpentText as string | null } : null;
};
const readReferenceDestinationRequest = (value: unknown): NativeReferenceTaskDestinationRequest | null => {
    const input = detach(value, 4096);
    if (!isRecord(input) || !exact(input, ['id', 'requestId', 'taskRevision', 'source', 'destination'])
        || input.source !== 'reference' || !isRecord(input.destination)) return null;
    const destination = input.destination;
    if (destination.kind === 'none' ? !exact(destination, ['kind'])
        : !['project', 'area'].includes(destination.kind as string) || !exact(destination, ['kind', 'id'])
            || typeof destination.id !== 'string' || !destination.id.trim() || destination.id.length > 500) return null;
    const base = readCompletionRequest({ id: input.id, requestId: input.requestId, taskRevision: input.taskRevision });
    return base ? { ...base, source: 'reference', destination: destination as TaskMoveDestination } : null;
};
const referenceDestinationAvailable = (destination: TaskMoveDestination, lists: Pick<Lists, 'projects' | 'areas'>): boolean =>
    destination.kind === 'none' || (destination.kind === 'project'
        ? lists.projects.some((row) => row.id === destination.id && !row.purgedAt && isSelectableProjectForTaskAssignment(row))
        : lists.areas.some((row) => row.id === destination.id && !row.deletedAt));
const readDoneCompletedAtRequest = (value: unknown): NativeDoneTaskCompletedAtRequest | null => {
    const input = detach(value);
    if (!isRecord(input) || !exact(input, ['id', 'requestId', 'taskRevision', 'completedAt'])
        || typeof input.completedAt !== 'string' || input.completedAt.length > 200
        || !resolveTaskEditorBackdatedCompletion({ completedAt: input.completedAt })) return null;
    const request = readCompletionRequest({ id: input.id, requestId: input.requestId, taskRevision: input.taskRevision });
    return request ? { ...request, completedAt: input.completedAt } : null;
};
const readCompletionUndoRequest = (value: unknown): NativeTaskCompletionUndoRequest | null => {
    const input = detach(value);
    return isRecord(input) && exact(input, ['requestId', 'completionRequestId'])
        && typeof input.requestId === 'string' && UUID.test(input.requestId)
        && typeof input.completionRequestId === 'string' && UUID.test(input.completionRequestId)
        && input.requestId !== input.completionRequestId ? input as NativeTaskCompletionUndoRequest : null;
};
const completionSaveRequest = (source: Task, requestId: string): NativeChecklistSaveRequest => ({
    id: source.id, requestId, base: { status: source.status }, patch: { status: 'done' },
    scheduleBase: getNativeTaskScheduleBase(source),
    checklist: { base: toChecklist(source.checklist), value: toChecklist(source.checklist) },
});
const doneStatusSaveRequest = (source: Task, request: NativeDoneTaskStatusRequest): NativeChecklistSaveRequest => ({
    ...completionSaveRequest(source, request.requestId), patch: { status: request.status },
    intent: isReferenceNextStatusRequest(request) ? 'referenceNext' : request.source === 'reference' ? 'referenceStatus' : 'doneStatus',
});
const completedAtSaveRequest = (source: Task, request: NativeDoneTaskCompletedAtRequest,
    intent: 'doneCompletedAt' | 'archiveCompletedAt'): NativeChecklistSaveRequest => ({
    ...completionSaveRequest(source, request.requestId), base: { completedAt: source.completedAt || '' },
    patch: { completedAt: request.completedAt }, intent,
});
const referenceCompletionSaveRequest = (source: Task, requestId: string): NativeChecklistSaveRequest => ({
    ...completionSaveRequest(source, requestId), intent: 'referenceComplete',
});
const referenceBackdateSaveRequest = (source: Task, request: NativeReferenceTaskBackdateRequest): NativeChecklistSaveRequest => {
    const resolved = resolveTaskEditorBackdatedCompletion({ completedAt: request.completedAt,
        ...(request.timeSpentText !== null ? { timeSpentText: request.timeSpentText } : {}) })!;
    return { ...completionSaveRequest(source, request.requestId), intent: 'referenceBackdate',
        base: { status: source.status, completedAt: source.completedAt || '',
            ...(request.timeSpentText !== null ? { timeSpentMinutes: source.timeSpentMinutes ?? null } : {}) },
        patch: { status: 'done', completedAt: resolved.completedAt,
            ...(request.timeSpentText !== null ? { timeSpentMinutes: resolved.timeSpentMinutes ?? null } : {}) } };
};
const referenceDestinationSaveRequest = (source: Task, request: NativeReferenceTaskDestinationRequest): NativeChecklistSaveRequest => {
    const patch = buildTaskMovePatch(request.destination, source);
    return { ...completionSaveRequest(source, request.requestId), intent: 'referenceDestination',
        base: { projectId: source.projectId ?? '', sectionId: source.sectionId ?? '', areaId: source.areaId ?? '' },
        patch: { projectId: patch.projectId ?? '', sectionId: patch.sectionId ?? '', areaId: patch.areaId ?? '' } };
};
const isReferenceMenuRequest = (request: NativeChecklistWriteRequest): boolean =>
    isSave(request) && (request.intent === 'referenceStatus' || request.intent === 'referenceComplete' || request.intent === 'referenceBackdate' || request.intent === 'referenceDestination');
const isReferenceOperation = (request: NativeChecklistWriteRequest): boolean => isReferenceNextRequest(request) || isReferenceMenuRequest(request);
const referenceContainerReadOnly = (task: Task, lists: Pick<Lists, 'projects' | 'sections'>): boolean => {
    const section = task.sectionId ? lists.sections.find((row) => row.id === task.sectionId) : null;
    if (section?.deletedAt) return true;
    const ids = [task.projectId, section?.projectId].filter(Boolean);
    return lists.projects.some((row) => ids.includes(row.id) && (row.status === 'archived' || row.deletedAt || row.purgedAt));
};
const isHistoryRowRequest = (request: NativeChecklistWriteRequest | null | undefined): boolean =>
    request != null && isSave(request) && (request.intent === 'doneStatus' || request.intent === 'referenceNext' || request.intent === 'referenceStatus' || request.intent === 'referenceComplete' || request.intent === 'referenceBackdate' || request.intent === 'referenceDestination' || request.intent === 'doneCompletedAt' || request.intent === 'archiveCompletedAt');
const isReferenceNextRequest = (request: NativeChecklistWriteRequest): boolean =>
    isSave(request) && request.intent === 'referenceNext';
const hasPurgedReferenceParent = (task: Task, projects: readonly Project[]): boolean =>
    Boolean(task.projectId && projects.find((project) => project.id === task.projectId)?.purgedAt);
const isArchiveCompletedAtRequest = (request: NativeChecklistWriteRequest): boolean =>
    isSave(request) && request.intent === 'archiveCompletedAt';
const isArchiveCompletedAtSource = (task: Task): boolean => task.status === 'archived'
    && !task.deletedAt && !task.purgedAt && !isTaskCancelled(task) && !isProjectedRecurringTaskId(task.id);
const validHistoryRowSource = (task: Task, request: NativeChecklistWriteRequest): boolean =>
    isArchiveCompletedAtRequest(request) ? isArchiveCompletedAtSource(task)
        : task.status === (isReferenceOperation(request) ? 'reference' : 'done') && !isProjectedRecurringTaskId(task.id);
export const canCompleteNativeTask = (task: Task, projects: readonly Project[], readOnly = false): boolean =>
    !readOnly && !task.deletedAt && !task.purgedAt && isTaskActionable(task)
    && !isProjectedRecurringTaskId(task.id) && !isStatusListTaskReadOnly(task, projects);
/** Scoped Board authority, including a Section-only parent; no new journal field. */
const boardCompletionContainer = (task: Task, lists: { projects: readonly Project[]; sections: readonly Section[] }) => {
    const id = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 500;
    if (task.projectId != null && !id(task.projectId) || task.sectionId != null && !id(task.sectionId)) return null;
    const sections = task.sectionId ? lists.sections.filter(row => row.id === task.sectionId) : [];
    if (task.sectionId && (sections.length !== 1 || !id(sections[0].projectId)
        || sections[0].deletedAt != null && typeof sections[0].deletedAt !== 'string' || sections[0].deletedAt)) return null;
    const section = sections[0];
    if (task.projectId && section && task.projectId !== section.projectId) return null;
    const parentId = task.projectId ?? section?.projectId;
    const parents = parentId ? lists.projects.filter(row => row.id === parentId) : [];
    if (parentId && (parents.length !== 1 || !['active', 'waiting', 'someday'].includes(parents[0].status)
        || parents[0].deletedAt != null && typeof parents[0].deletedAt !== 'string'
        || parents[0].purgedAt != null && typeof parents[0].purgedAt !== 'string' || parents[0].deletedAt || parents[0].purgedAt)) return null;
    const parent = parents[0];
    return { section: section ? { id: section.id, projectId: section.projectId, deletedAt: section.deletedAt ?? null } : null,
        parent: parent ? { id: parent.id, status: parent.status, deletedAt: parent.deletedAt ?? null, purgedAt: parent.purgedAt ?? null } : null };
};
const sameBoardCompletionContainer = (source: Task, lists: Pick<Lists, 'projects' | 'sections'>, data: AppData): boolean => {
    const captured = boardCompletionContainer(source, lists);
    const fresh = boardCompletionContainer(source, { projects: data.projects, sections: data.sections ?? [] });
    return captured !== null && fresh !== null && same(captured, fresh);
};
export const canCompleteNativeBoardTask = (task: Task, projects: readonly Project[], sections: readonly Section[], readOnly = false): boolean =>
    canCompleteNativeTask(task, projects, readOnly) && ['inbox', 'next', 'waiting', 'someday'].includes(task.status)
    && boardCompletionContainer(task, { projects, sections }) !== null;
const boardUndoContainerMatches = (completion: NativeTaskCompletionEnvelope, source: Task, lists: Pick<Lists, 'projects' | 'sections'>): boolean => {
    const after = completion.prepared.checklist.effect.tasks.find(row => row.after.id === completion.request.id)?.after;
    if (!after || (source.projectId ?? null) !== (after.projectId ?? null) || (source.sectionId ?? null) !== (after.sectionId ?? null)
        || !boardCompletionContainer(source, lists)) return false;
    // RN normalization can detach a Section-only source. Its original context
    // still owns this Undo, while current parent status is evaluated as policy.
    const original = completion.prepared.checklist.witness;
    if (!boardCompletionContainer(original.source, lists)) return false;
    const originalSection = original.lists.sections.find(row => row.id === original.source.sectionId);
    const currentSection = lists.sections.find(row => row.id === original.source.sectionId);
    return !original.source.sectionId || Boolean(originalSection && currentSection && originalSection.projectId === currentSection.projectId);
};
export const canCancelNativeTask = (task: Task, projects: readonly Project[], readOnly = false): boolean =>
    !readOnly && !task.deletedAt && !task.purgedAt && isTaskActionable(task)
    && !isProjectedRecurringTaskId(task.id) && !isStatusListTaskReadOnly(task, projects);
export const canSkipNativeTaskOccurrence = (task: Task, projects: readonly Project[], readOnly = false): boolean =>
    !readOnly && !isProjectedRecurringTaskId(task.id) && !isStatusListTaskReadOnly(task, projects)
    && canSkipRecurringTaskOccurrence(task);
const draftRequest = (request: NativeChecklistSaveRequest): NativeTaskDraftSaveRequest => ({
    id: request.id, base: request.base, patch: request.patch, scheduleBase: request.scheduleBase,
    ...(request.recurrenceBase ? { recurrenceBase: request.recurrenceBase } : {}),
    ...(request.attachments ? { attachments: request.attachments } : {}),
});
const readRequest = (value: unknown, validateField: (field: TaskDraftField, value: unknown) => boolean): NativeChecklistWriteRequest | null => {
    const input = detach(value);
    if (!isRecord(input) || typeof input.id !== 'string' || !input.id.trim() || input.id.length > 500
        || typeof input.requestId !== 'string' || !UUID.test(input.requestId)) return null;
    if (!own(input, 'checklist')) {
        const checklistBase = readChecklist(input.checklistBase, true);
        return exact(input, ['id', 'requestId', 'checklistBase']) && checklistBase
            ? { id: input.id, requestId: input.requestId, checklistBase } : null;
    }
    if (!isRecord(input.checklist) || !exact(input.checklist, ['base', 'value'])) return null;
    const base = readChecklist(input.checklist.base, true);
    const selected = readChecklist(input.checklist.value, true);
    const bare = { id: input.id, base: input.base, patch: input.patch, scheduleBase: input.scheduleBase,
        ...(own(input, 'recurrenceBase') ? { recurrenceBase: input.recurrenceBase } : {}),
        ...(own(input, 'attachments') ? { attachments: input.attachments } : {}) };
    // This row action uses shared canonical instant validation, independently
    // of the general editor date format. Only its prior string baseline may be
    // invalid; the outer wrapper binds the complete source and new instant.
    const fields = (input.intent === 'doneCompletedAt' || input.intent === 'archiveCompletedAt' || input.intent === 'referenceBackdate')
        ? (field: TaskDraftField, value: unknown) => field === 'completedAt'
            ? typeof value === 'string' && value.length <= 200
                && ((isRecord(input.base) && value === input.base.completedAt)
                    || resolveTaskEditorBackdatedCompletion({ completedAt: value }) !== null)
            : validateField(field, value)
        : validateField;
    const parsed = readNativeTaskDraftSaveRequest(bare, fields, true, false, true);
    if (!base || !selected || !parsed || (own(input, 'intent') && input.intent !== 'cancel' && input.intent !== 'skip' && input.intent !== 'doneStatus' && input.intent !== 'referenceNext' && input.intent !== 'referenceStatus' && input.intent !== 'referenceComplete' && input.intent !== 'referenceBackdate' && input.intent !== 'referenceDestination' && input.intent !== 'doneCompletedAt' && input.intent !== 'archiveCompletedAt')
        || !exact(input, ['id', 'requestId', 'base', 'patch', 'scheduleBase', 'checklist',
            ...(parsed.recurrenceBase ? ['recurrenceBase'] : []), ...(parsed.attachments ? ['attachments'] : []),
            ...(input.intent === 'cancel' || input.intent === 'skip' || input.intent === 'doneStatus' || input.intent === 'referenceNext' || input.intent === 'referenceStatus' || input.intent === 'referenceComplete' || input.intent === 'referenceBackdate' || input.intent === 'referenceDestination' || input.intent === 'doneCompletedAt' || input.intent === 'archiveCompletedAt' ? ['intent'] : [])])) return null;
    if (input.intent === 'doneStatus' && (!exact(parsed.base, ['status']) || parsed.base.status !== 'done'
        || !exact(parsed.patch, ['status']) || parsed.patch.status === 'done'
        || !DONE_STATUS_OPTIONS.includes(parsed.patch.status as NativeDoneTaskStatus)
        || parsed.recurrenceBase || parsed.attachments || !same(base, selected))) return null;
    if (input.intent === 'referenceNext' && (!exact(parsed.base, ['status']) || parsed.base.status !== 'reference'
        || !exact(parsed.patch, ['status']) || parsed.patch.status !== 'next'
        || parsed.recurrenceBase || parsed.attachments || !same(base, selected))) return null;
    if ((input.intent === 'referenceStatus' || input.intent === 'referenceComplete') && (!exact(parsed.base, ['status'])
        || parsed.base.status !== 'reference' || !exact(parsed.patch, ['status'])
        || !(input.intent === 'referenceComplete' ? parsed.patch.status === 'done' : ['inbox', 'waiting', 'someday'].includes(parsed.patch.status as string))
        || parsed.recurrenceBase || parsed.attachments || !same(base, selected))) return null;
    if ((input.intent === 'doneCompletedAt' || input.intent === 'archiveCompletedAt') && (!exact(parsed.base, ['completedAt'])
        || !exact(parsed.patch, ['completedAt']) || typeof parsed.patch.completedAt !== 'string'
        || !resolveTaskEditorBackdatedCompletion({ completedAt: parsed.patch.completedAt })
        || parsed.recurrenceBase || parsed.attachments || !same(base, selected))) return null;
    if (input.intent === 'referenceBackdate' && (!exact(parsed.base, ['status', 'completedAt', ...(own(parsed.patch, 'timeSpentMinutes') ? ['timeSpentMinutes'] : [])])
        || !exact(parsed.patch, ['status', 'completedAt', ...(own(parsed.patch, 'timeSpentMinutes') ? ['timeSpentMinutes'] : [])])
        || parsed.base.status !== 'reference' || parsed.patch.status !== 'done' || typeof parsed.patch.completedAt !== 'string'
        || !resolveTaskEditorBackdatedCompletion({ completedAt: parsed.patch.completedAt })
        || parsed.recurrenceBase || parsed.attachments || !same(base, selected))) return null;
    if (input.intent === 'referenceDestination' && (!exact(parsed.base, ['projectId', 'sectionId', 'areaId'])
        || !exact(parsed.patch, ['projectId', 'sectionId', 'areaId']) || parsed.recurrenceBase || parsed.attachments || !same(base, selected))) return null;
    return { ...parsed, requestId: input.requestId, checklist: { base, value: selected },
        ...(input.intent === 'cancel' || input.intent === 'skip' || input.intent === 'doneStatus' || input.intent === 'referenceNext' || input.intent === 'referenceStatus' || input.intent === 'referenceComplete' || input.intent === 'referenceBackdate' || input.intent === 'referenceDestination' || input.intent === 'doneCompletedAt' || input.intent === 'archiveCompletedAt' ? { intent: input.intent } : {}) };
};

// This selection is closed by the internal factory, never by a request flag.
type ChecklistSelection = {
    readRequest: typeof readRequest; mergeAttachments: typeof mergeNativeTaskLinkHalf;
};
const ownedChecklistSelection: ChecklistSelection = {
    readRequest: (value, validateField) => {
        const input = detach(value, 8 * 1024 * 1024);
        if (!isRecord(input) || !exact(input, ['id', 'requestId', 'base', 'patch', 'scheduleBase', 'checklist', 'attachments',
            ...(own(input, 'recurrenceBase') ? ['recurrenceBase'] : []), ...(own(input, 'intent') ? ['intent'] : [])])
            || typeof input.requestId !== 'string' || input.requestId.length !== 36 || !UUID.test(input.requestId)
            || own(input, 'intent') && input.intent !== 'cancel' && input.intent !== 'skip'
            || !isRecord(input.checklist) || !exact(input.checklist, ['base', 'value'])
            || !isRecord(input.attachments) || !exact(input.attachments, ['base', 'value'])) return null;
        const base = readChecklist(input.checklist.base, true), selected = readChecklist(input.checklist.value, true);
        const attachmentBase = readNativeAttachments(input.attachments.base), attachments = readNativeAttachments(input.attachments.value);
        const bare = { id: input.id, base: input.base, patch: input.patch, scheduleBase: input.scheduleBase,
            ...(own(input, 'recurrenceBase') ? { recurrenceBase: input.recurrenceBase } : {}) };
        const parsed = readNativeTaskDraftSaveRequest(bare, validateField, true, true);
        return parsed && base && selected && attachmentBase && attachments ? { ...parsed, requestId: input.requestId,
            checklist: { base, value: selected }, attachments: { base: attachmentBase, value: attachments },
            ...(own(input, 'intent') ? { intent: input.intent as 'cancel' | 'skip' } : {}) } : null;
    },
    mergeAttachments: (stored, half) => readNativeAttachments(mergeTaskDraftAttachments(stored, half.base, half.value)),
};

const futureBoundary = (preparedAt: string) => {
    const end = new Date(preparedAt);
    end.setHours(23, 59, 59, 999);
    return end.toISOString();
};
const changedRows = <T extends { id: string }>(before: T[], after: T[]): Array<{ before: T | null; after: T }> => {
    const old = new Map(before.map((row) => [row.id, row]));
    return after.filter((row) => !same(old.get(row.id), row)).map((row) => ({ before: old.get(row.id) ?? null, after: row }));
};
const resetResult = (task: Task): NativeChecklistResult => ({ id: task.id,
    checklistBase: toChecklist(task.checklist), status: task.status,
    completedAt: task.completedAt ?? null, isFocusedToday: task.isFocusedToday === true });

const cleared = (value: Partial<Task>) => Object.keys(value).filter((key) => value[key as keyof Task] === undefined).sort();
const restoreClears = (value: Partial<Task>, fields: string[]): Partial<Task> => ({ ...value,
    ...Object.fromEntries(fields.map((field) => [field, undefined])) });
const validClears = (value: Partial<Task>, fields: string[]) => fields.every((field) =>
    typeof field === 'string' && field.length <= 100 && !own(value, field))
    && new Set(fields).size === fields.length;
const directSaveUpdates = (source: Task, request: NativeChecklistSaveRequest, preparedAt?: string,
    selection?: ChecklistSelection, boardCompletion = false): Partial<Task> | null => {
    if (boardCompletion) return same(request, completionSaveRequest(source, request.requestId)) ? { status: 'done' } : null;
    if (request.intent === 'referenceDestination') return {
        projectId: request.patch.projectId || undefined, sectionId: request.patch.sectionId || undefined, areaId: request.patch.areaId || undefined,
    };
    if (request.intent === 'referenceBackdate') return { status: 'done', completedAt: request.patch.completedAt,
        ...(own(request.patch, 'timeSpentMinutes') ? { timeSpentMinutes: request.patch.timeSpentMinutes ?? undefined } : {}) };
    // Done metadata actions use the exact RN row patch, without editor cleanup.
    if (request.intent === 'doneStatus' || request.intent === 'referenceNext' || isReferenceMenuRequest(request)) return { status: request.patch.status };
    if (request.intent === 'doneCompletedAt' || request.intent === 'archiveCompletedAt') return { completedAt: request.patch.completedAt };
    const attachments = request.attachments
        ? (selection?.mergeAttachments ?? mergeNativeTaskLinkHalf)(source.attachments ?? [], request.attachments) : source.attachments;
    if (attachments === null) return null;
    const draft = applyTaskDraftPatch(createTaskDraft(source), nativeTaskDraftPatchValues(draftRequest(request)));
    // Swift's sorted JSON keys must not turn an unchanged checklist into a draft edit.
    const editSource = { ...source, checklist: toChecklist(source.checklist) };
    const updates = buildTaskEditUpdatePatch({ draft, checklist: toChecklist(request.checklist.value),
        attachments }, editSource);
    if (!updates) return null;
    if (request.attachments && !same(source.attachments ?? [], attachments)) updates.attachments = attachments;
    for (const field of ['startTime', 'dueDate', 'relativeStartOffset', 'reviewAt'] as const) {
        if (own(request.patch, field)) Object.assign(updates, { [field]: draft[field] || undefined });
    }
    if (request.intent === 'cancel') {
        if (!preparedAt) return null;
        Object.assign(updates, { status: 'archived', cancelledAt: preparedAt, completedAt: undefined });
    }
    return updates;
};
const temporal = new Set(['startTime', 'dueDate', 'relativeStartOffset', 'reviewAt']);
const directIsBound = (source: Task, request: NativeChecklistSaveRequest, witness: Witness, selection?: ChecklistSelection, boardCompletion = false): boolean => {
    const expected = directSaveUpdates(source, request, witness.preparedAt, selection, boardCompletion);
    if (!expected || !validClears(witness.direct, witness.directClears)) return false;
    const frozen = restoreClears(witness.direct, witness.directClears);
    const names = new Set([...Object.keys(expected), ...Object.keys(frozen)]);
    for (const name of names) {
        if (temporal.has(name)) {
            // Date/link projections can depend on the preparing process's zone.
            // Only fields actually requested (and their linked start) may vary.
            if (!own(request.patch, name)
                && !(name === 'startTime' && (own(request.patch, 'dueDate') || own(request.patch, 'relativeStartOffset')))
                && !same(expected[name as keyof Task], frozen[name as keyof Task])) return false;
        } else if (!same(expected[name as keyof Task], frozen[name as keyof Task])
            || own(expected, name) !== own(frozen, name)) return false;
    }
    return true;
};
const deviceId = (witness: Witness) => witness.deviceIdBefore ?? witness.deviceIdToInitialize ?? 'native-noop-calculation';
const effectResult = (kind: 'save' | 'reset', effect: PreparedChecklistEffect,
    request: NativeChecklistWriteRequest, witness: Witness): NativeChecklistResult => {
    const updated = effect.tasks.find((row) => row.after.id === effect.sourceBefore.id)?.after;
    if (!updated) throw new Error('Missing checklist source effect');
    if (kind === 'reset') return resetResult(updated);
    if (isSave(request) && request.intent === 'cancel') {
        if (updated.status !== 'archived' || updated.cancelledAt !== witness.preparedAt
            || !validCancelText(witness.cancelMessage, 512) || !validCancelText(witness.cancelUndoLabel, 80))
            throw new Error('Invalid cancellation effect');
        return { id: updated.id, cancellation: {
            cancelledAt: updated.cancelledAt,
            undoEnabled: witness.settings.undoNotificationsEnabled !== false,
            message: witness.cancelMessage,
            undoLabel: witness.cancelUndoLabel,
        } };
    }
    return { id: updated.id };
};

const plan = (kind: 'save' | 'reset', request: NativeChecklistWriteRequest, witness: Witness,
    allowIds = false, undo = false, selection?: ChecklistSelection, boardCompletion = false): {
    effect: PreparedChecklistEffect; result: NativeChecklistResult;
} => {
    const source = witness.source;
    const lists = witness.lists;
    let tasks: Task[];
    let projects: Project[];
    let sections: Section[];
    let recurringCandidate: Task | null = null;
    let recurringDuplicate: Task | null = null;
    let generated = 0;
    let direct: Partial<Task> = {};
    let referenceFillsFocusSlot = false;
    if (kind === 'save' && isSave(request)) {
        if (selection && !undo && !directIsBound(source, request, witness, selection)) throw new Error('Owned direct update is not bound');
        if (request.intent === 'referenceBackdate'
            && isTaskEditorTimeSpentEnabled(witness.settings) !== own(request.patch, 'timeSpentMinutes'))
            throw new Error('Reference completion minutes feature changed');
        direct = restoreClears(witness.direct, witness.directClears);
        const prepared = prepareTaskUpdatesForStore({ task: source, updates: direct,
            allProjects: lists.projects, allSections: lists.sections, allAreas: lists.areas,
            settings: witness.settings, futureBoundary: witness.futureBoundary,
            nowMs: Date.parse(witness.preparedAt), reserveProjectOrder: !boardCompletion,
            projectOrderReserver: boardCompletion || request.intent === 'referenceDestination' ? undefined : createProjectOrderReserver(lists.tasks) });
        if (!prepared.ok) throw new Error(prepared.error);
        if (isReferenceOperation(request)) {
            if (witness.focusLimit !== normalizeFocusTaskLimit(witness.settings.gtd?.focusTaskLimit))
                throw new Error('Reference Focus limit is not bound to settings');
            referenceFillsFocusSlot = countFocusedTasksBeforeBoundary([source], witness.futureBoundary) === 0
                && countFocusedTasksBeforeBoundary([{ ...source, ...prepared.updates }], witness.futureBoundary) === 1;
            if (referenceFillsFocusSlot && witness.focusCount >= witness.focusLimit)
                throw new Error(`Focus limit of ${witness.focusLimit} reached`);
        }
        const skip = request.intent === 'skip';
        if (skip && (!canSkipNativeTaskOccurrence(source, lists.projects)
            || !canSkipRecurringTaskOccurrence({ ...source, ...prepared.updates }))) {
            throw new Error('Task draft cannot skip an occurrence');
        }
        const createId = () => {
            let id = witness.ids[generated++];
            if (!id && allowIds && witness.ids.length < Math.floor(LIMIT_BYTES / 38)) {
                id = generateUUID();
                witness.ids.push(id);
            }
            if (!id) throw new Error('Missing frozen checklist child ID');
            return id;
        };
        // A clean Skip has one lifecycle transition. A dirty Skip first resolves
        // the ordinary Save, then archives that row in the same atomic effect.
        const hasDraftUpdate = selection && !skip ? Object.keys(direct).some((field) => !same(source[field as keyof Task], direct[field as keyof Task]))
            : !skip || Object.keys(direct).length > 0;
        const effects = hasDraftUpdate ? planTaskUpdateEffects({ task: source, preparedUpdates: prepared.updates,
            allTasks: lists.tasks, allProjects: lists.projects, allSections: lists.sections,
            now: witness.preparedAt, deviceId: deviceId(witness), createId,
            recurrenceProjection: !skip && prepared.updates.status === 'done' && source.status !== 'done'
                && source.status !== 'archived' ? witness.recurrenceProjection : undefined }) : null;
        tasks = effects?.tasks ?? lists.tasks;
        projects = effects?.projects ?? lists.projects;
        sections = effects?.sections ?? lists.sections;
        recurringCandidate = effects?.recurringCandidateTask ?? null;
        recurringDuplicate = effects?.recurringDuplicateTask ?? null;
        if (skip) {
            const draftResolved = effects?.updatedTask ?? source;
            if (!canSkipRecurringTaskOccurrence(draftResolved)) throw new Error('Task draft cannot skip an occurrence');
            if (allowIds) witness.recurrenceProjection = projectNextRecurringTask(draftResolved, witness.preparedAt, true);
            if (!matchesAdvanceOneCalendarProjection(draftResolved, witness.preparedAt,
                witness.recurrenceProjection, witness.calendarTimeZone ?? '')) {
                throw new Error('Invalid frozen recurrence calendar step');
            }
            const skipped = planSkippedRecurringOccurrence({ task: draftResolved, allTasks: tasks,
                now: witness.preparedAt, deviceId: deviceId(witness),
                projection: witness.recurrenceProjection, createId });
            tasks = skipped.tasks;
            recurringCandidate = skipped.recurringCandidateTask;
            recurringDuplicate = skipped.recurringDuplicateTask;
        }
    } else if (kind === 'reset' && !isSave(request)) {
        const after: Task = { ...source, ...buildResetTaskChecklistUpdates(source),
            updatedAt: witness.preparedAt, rev: nextRevision(source.rev), revBy: deviceId(witness) };
        tasks = lists.tasks.map((task) => task.id === source.id ? after : task);
        projects = lists.projects;
        sections = lists.sections;
    } else throw new Error('Checklist request kind does not match');
    if (generated !== witness.ids.length) throw new Error('Unused checklist child IDs');
    const taskRows = changedRows(lists.tasks, tasks);
    const projectRows = changedRows(lists.projects, projects);
    const sectionRows = changedRows(lists.sections, sections);
    const reopened = projectRows.find((row) => row.before?.status === 'archived' && row.after.status === 'active');
    const sourceEffect = taskRows.find((row) => row.after.id === source.id)?.after;
    const unchanged = selection && !sourceEffect && !taskRows.length && !projectRows.length && !sectionRows.length
        && isSave(request) && !request.intent && witness.ids.length === 0;
    const afterSource = sourceEffect ?? (unchanged ? source : null);
    if (!afterSource) throw new Error('Checklist write has no task effect');
    const targetProject = afterSource.projectId ? lists.projects.find((project) => project.id === afterSource.projectId) ?? null : null;
    const selectedArea = afterSource.areaId ? lists.areas.find((area) => area.id === afterSource.areaId) ?? null : null;
    const orderProjectIds = Array.from(new Set(taskRows.filter((row) => row.after.projectId
        && (!row.before || row.after.order !== row.before.order || row.after.orderNum !== row.before.orderNum))
        .map((row) => row.after.projectId!)));
    const guards: PreparedChecklistEffect['guards'] = {
        selectedProject: targetProject && !projectRows.some((row) => row.after.id === targetProject.id) ? targetProject : null,
        selectedArea,
        taskOrders: orderProjectIds.map((projectId) => ({ projectId,
            max: (getNextProjectOrder(projectId, lists.tasks) ?? 0) - 1 })),
        reactivation: reopened ? { projectId: reopened.after.id,
            taskIds: lists.tasks.filter((task) => task.projectId === reopened.after.id).map((task) => task.id).sort(),
            sectionIds: lists.sections.filter((section) => section.projectId === reopened.after.id).map((section) => section.id).sort() } : null,
        recurringCandidate,
        recurringDuplicate,
        focusCount: referenceFillsFocusSlot || direct.isFocusedToday === true && source.isFocusedToday !== true ? witness.focusCount : null,
        focusLimit: referenceFillsFocusSlot || direct.isFocusedToday === true && source.isFocusedToday !== true ? witness.focusLimit : null,
        focusBoundary: referenceFillsFocusSlot || direct.isFocusedToday === true && source.isFocusedToday !== true ? witness.futureBoundary : null,
        autoArchiveDays: kind === 'save' && !isReferenceOperation(request) ? witness.settings.gtd?.autoArchiveDays ?? null : null,
    };
    const effect: PreparedChecklistEffect = { sourceBefore: source, tasks: taskRows,
        projects: projectRows, sections: sectionRows, deviceIdBefore: witness.deviceIdBefore,
        deviceIdToInitialize: witness.deviceIdToInitialize, guards };
    return { effect, result: undo || unchanged ? { id: source.id } : effectResult(kind, effect, request, witness) };
};

/** Keep only rows the deterministic planner reads; never journal the library. */
const reduceWitness = (witness: Witness, effect: PreparedChecklistEffect, state: Pick<TaskStore, '_allTasks' | '_allProjects' | '_allSections' | '_allAreas'>, reference = false, retainedContext?: Task): void => {
    const tasks = new Set<string>([
        witness.source.id,
        ...effect.tasks.flatMap((row) => [row.before?.id, row.after.id].filter((id): id is string => Boolean(id))),
        ...(effect.guards.reactivation?.taskIds ?? []),
        ...(effect.guards.recurringDuplicate ? [effect.guards.recurringDuplicate.id] : []),
    ]);
    for (const { projectId } of effect.guards.taskOrders) {
        const ranked = state._allTasks.filter((task) => task.projectId === projectId && !task.deletedAt)
            .sort((left, right) => (getTaskOrder(right) ?? -1) - (getTaskOrder(left) ?? -1));
        if (ranked[0]) tasks.add(ranked[0].id);
    }
    const projects = new Set<string>([
        ...effect.projects.flatMap((row) => [row.before?.id, row.after.id].filter((id): id is string => Boolean(id))),
        ...[witness.source.projectId, retainedContext?.projectId, effect.guards.selectedProject?.id, effect.guards.reactivation?.projectId,
            effect.tasks.find((row) => row.after.id === witness.source.id)?.after.projectId].filter((id): id is string => Boolean(id)),
    ]);
    const sections = new Set<string>([
        ...effect.sections.flatMap((row) => [row.before?.id, row.after.id].filter((id): id is string => Boolean(id))),
        ...effect.guards.reactivation?.sectionIds ?? [],
        ...[witness.source.sectionId, retainedContext?.sectionId, effect.tasks.find((row) => row.after.id === witness.source.id)?.after.sectionId]
            .filter((id): id is string => Boolean(id)),
    ]);
    if (reference) for (const section of state._allSections) if (sections.has(section.id)) projects.add(section.projectId);
    const areas = new Set<string>([witness.source.areaId, effect.guards.selectedArea?.id,
        effect.tasks.find((row) => row.after.id === witness.source.id)?.after.areaId]
        .filter((id): id is string => Boolean(id)));
    witness.lists = {
        tasks: state._allTasks.filter((row) => tasks.has(row.id)),
        projects: state._allProjects.filter((row) => projects.has(row.id)),
        sections: state._allSections.filter((row) => sections.has(row.id)),
        areas: state._allAreas.filter((row) => areas.has(row.id)),
    };
};

const readChecklistPrepared = (
    input: unknown,
    validateField: (field: TaskDraftField, value: unknown) => boolean,
    selection?: ChecklistSelection,
    boardCompletion = false,
): NativePreparedChecklistWrite | OwnedChecklistProof | null => {
    const envelope = detach(input, selection ? 16 * 1024 * 1024 : LIMIT_BYTES);
    if (!isRecord(envelope) || !exact(envelope, ['request', 'prepared']) || !isRecord(envelope.prepared)) return null;
    const request = (selection?.readRequest ?? readRequest)(envelope.request, validateField);
    const raw = envelope.prepared;
    const noop = Boolean(selection && raw.kind === 'noop');
    if (!request || !exact(raw, ['version', 'kind', 'request', 'witness', 'result',
        ...(!noop ? ['effect'] : []), ...(selection ? ['rawBefore'] : [])])
        || raw.version !== (selection ? 2 : 1) || !(selection ? ['save', 'noop'] : ['save', 'reset']).includes(raw.kind as string)
        || !same(request, raw.request) || !isRecord(raw.witness) || !noop && !isRecord(raw.effect)
        || !isRecord(raw.result)) return null;
    const prepared = raw as unknown as NativePreparedChecklistWrite;
    const witness = prepared.witness, kind = noop ? 'save' : prepared.kind;
    if (kind !== (isSave(request) ? 'save' : 'reset')
        || !exact(witness as unknown as Record<string, unknown>, [
            'source', 'lists', 'settings', 'preparedAt', 'preparedLocalDay', 'preparedOffsetMinutes',
            'boundaryOffsetMinutes', 'futureBoundary', 'deviceIdBefore', 'deviceIdToInitialize',
            'recurrenceProjection', 'ids', 'directClears', 'direct', 'focusCount', 'focusLimit',
            ...(isSave(request) && request.intent === 'skip' ? ['calendarTimeZone'] : []),
            ...(isSave(request) && request.intent === 'cancel' ? ['cancelMessage', 'cancelUndoLabel'] : []),
        ]) || !isRecord(witness.source) || !isRecord(witness.lists) || !isRecord(witness.settings)
        || !exact(witness.lists, ['tasks', 'projects', 'sections', 'areas'])
        || !Array.isArray(witness.lists.tasks) || !Array.isArray(witness.lists.projects)
        || !Array.isArray(witness.lists.sections) || !Array.isArray(witness.lists.areas)
        || !witness.lists.tasks.every(isRecord) || !witness.lists.projects.every(isRecord)
        || !witness.lists.sections.every(isRecord) || !witness.lists.areas.every(isRecord)
        || !isRecord(witness.direct) || !Array.isArray(witness.directClears)
        || !validClears(witness.direct, witness.directClears)
        || !Array.isArray(witness.ids) || witness.ids.some((id) => typeof id !== 'string' || !UUID.test(id))
        || new Set(witness.ids).size !== witness.ids.length
        || witness.ids.some((id) => witness.lists.tasks.some((task) => task.id === id))
        || witness.source.id !== request.id || typeof witness.source.title !== 'string'
        || typeof witness.source.status !== 'string' || typeof witness.source.createdAt !== 'string'
        || typeof witness.source.updatedAt !== 'string' || witness.source.deletedAt || witness.source.purgedAt
        || !same(witness.lists.tasks.find((task) => task.id === request.id), witness.source)
        || (!isArchiveCompletedAtRequest(request) && isStatusListTaskReadOnly(witness.source, witness.lists.projects as Project[]))
        || (isReferenceOperation(request) && hasPurgedReferenceParent(witness.source, witness.lists.projects as Project[]))
        || (isReferenceMenuRequest(request) && referenceContainerReadOnly(witness.source, witness.lists))
        || typeof witness.preparedAt !== 'string' || !Number.isFinite(Date.parse(witness.preparedAt))
        || new Date(witness.preparedAt).toISOString() !== witness.preparedAt
        || typeof witness.preparedLocalDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(witness.preparedLocalDay)
        || !Number.isInteger(witness.preparedOffsetMinutes) || Math.abs(witness.preparedOffsetMinutes) > 840
        || !Number.isInteger(witness.boundaryOffsetMinutes) || Math.abs(witness.boundaryOffsetMinutes) > 840
        || new Date(Date.parse(witness.preparedAt) - witness.preparedOffsetMinutes * 60_000).toISOString().slice(0, 10)
            !== witness.preparedLocalDay
        || new Date(Date.parse(`${witness.preparedLocalDay}T23:59:59.999Z`)
            + witness.boundaryOffsetMinutes * 60_000).toISOString() !== witness.futureBoundary
        || witness.deviceIdBefore !== (witness.settings.deviceId ?? null)
        || (noop ? witness.deviceIdToInitialize !== null : witness.deviceIdBefore === null
            ? typeof witness.deviceIdToInitialize !== 'string' || !UUID.test(witness.deviceIdToInitialize)
            : witness.deviceIdToInitialize !== null)
        || !Number.isSafeInteger(witness.focusCount) || witness.focusCount < 0
        || !Number.isSafeInteger(witness.focusLimit) || witness.focusLimit < 1
        || (isSave(request) && request.intent === 'cancel' && (!validCancelText(witness.cancelMessage, 512)
            || !validCancelText(witness.cancelUndoLabel, 80) || !canCancelNativeTask(witness.source,
                witness.lists.projects as Project[])
            || witness.recurrenceProjection !== null
            || (witness.settings.undoNotificationsEnabled !== undefined
                && typeof witness.settings.undoNotificationsEnabled !== 'boolean')))
        || (isSave(request) && request.intent === 'skip'
            && !canSkipNativeTaskOccurrence(witness.source, witness.lists.projects as Project[]))) return null;
    if (isSave(request)) {
        if (!validNativeTaskDraftBases(witness.source, draftRequest(request))
            || !same(toChecklist(witness.source.checklist), request.checklist.base)
            || !directIsBound(witness.source, request, witness, selection, boardCompletion)
            || (isHistoryRowRequest(request) && !validHistoryRowSource(witness.source, request))
            || ((witness.source.status === 'reference' || request.patch.status === 'reference')
                && (request.patch.priority || request.patch.timeEstimate))) return null;
    } else if (!same(toChecklist(witness.source.checklist), request.checklistBase)
        || request.checklistBase.length === 0 || Object.keys(witness.direct).length > 0
        || witness.directClears.length > 0 || witness.ids.length > 0
        || witness.recurrenceProjection !== null) return null;
    try {
        const planned = plan(kind, request, witness, false, false, selection, boardCompletion);
        if (noop) {
            if (!isSave(request) || request.intent || planned.effect.tasks.length || planned.effect.projects.length
                || planned.effect.sections.length || !validRawTask(raw.rawBefore, request.id)
                || !same(historyRowLoadProjection(raw.rawBefore, witness.preparedAt), witness.source)
                || !same(planned.result, prepared.result)) return null;
            return raw as unknown as NativeOwnedCompleteChecklistNoop;
        }
        if (isSave(request)) {
            const after = planned.effect.tasks.find((row) => row.after.id === request.id)?.after;
            if (!after || !isHistoryRowRequest(request)
                && !validNativeTaskDraftScheduleEffect(witness.source, draftRequest(request), after, validateField)) return null;
        }
        return same(planned.effect, prepared.effect) && same(planned.result, prepared.result)
            && (!selection || validOwnedChecklistRawBefore(raw.rawBefore, planned.effect, witness.preparedAt))
            ? raw as unknown as NativePreparedChecklistWrite | NativePreparedOwnedCompleteChecklistSave : null;
    } catch {
        return null;
    }
};
const readPrepared = (input: unknown, validateField: (field: TaskDraftField, value: unknown) => boolean, boardCompletion = false): NativePreparedChecklistWrite | null =>
    readChecklistPrepared(input, validateField, undefined, boardCompletion) as NativePreparedChecklistWrite | null;

/** The actual SQLite display codec followed by the normal load projection. */
export const historyRowLoadProjection = (task: Task, preparedAt: string, temporal?: TaskLoadTemporalContext): Task => {
    const values = taskToSqliteRow(task);
    const row = Object.fromEntries(TASK_SQLITE_COLUMNS.map((column, index) => [column, values[index]]));
    return normalizeTaskForLoad(mapSqliteTaskRow(row), preparedAt, temporal);
};
const validReferenceRawTask = (task: unknown, id: string): task is Task => isRecord(task)
    && validRawTask({ ...task, tags: task.tags ?? [], contexts: task.contexts ?? [] }, id);
const sameRawHistoryRowTask = (left: Task, right: Task): boolean =>
    sameTaskSqliteRow(left, right) && sameSectionDeleteJson(left, right);
// Owned guards recover exact JSON members from durable-read provenance.
const sameOwnedRawTask = (left: Task, right: Task): boolean => {
    const before = rawReadTaskSnapshot(left), after = rawReadTaskSnapshot(right);
    return before !== null && after !== null && sameRawHistoryRowTask(before, after);
};
// Owned AFTER uses the writer's exact encoding (empty checklist -> NULL).
// BEFORE stays raw; historical envelopes retain their existing comparator.
const sameOwnedTaskAfter = (current: Task, expected: Task): boolean => {
    const values = taskToSqliteRow(expected);
    const row = Object.fromEntries(TASK_SQLITE_COLUMNS.map((column, index) => [column, values[index]]));
    const stored = mapSqliteTaskRow(row);
    rememberRawReadRow(stored, row, TASK_SQLITE_COLUMNS, taskToSqliteRow(stored));
    return sameOwnedRawTask(current, stored);
};
// Only the single source update can enter the existing raw Task overlay.
const validHistoryRowEffect = (checklist: NativePreparedChecklistWrite, id: string): boolean => {
    const { effect } = checklist;
    const reference = isReferenceOperation(checklist.request);
    return effect.tasks.length === 1 && effect.tasks[0].before !== null
        && effect.tasks[0].after.id === id && same(effect.tasks[0].before, checklist.witness.source)
        && effect.projects.length === 0 && effect.sections.length === 0
        && effect.guards.reactivation === null && effect.guards.recurringCandidate === null
        && effect.guards.recurringDuplicate === null
        && (reference ? checklist.witness.ids.length === 0 && checklist.witness.recurrenceProjection === null
            : effect.guards.focusCount === null && effect.guards.focusLimit === null && effect.guards.focusBoundary === null);
};
const validHistoryRowRawBefore = (rawBefore: Task, request: NativeTaskCompletionRequest, witness: Witness, archived = false): boolean => {
    if (!(request.source === 'reference' && !isReferenceNextStatusRequest(request) ? validReferenceRawTask(rawBefore, request.id) : validRawTask(rawBefore, request.id)) || (archived ? !isArchiveCompletedAtSource(rawBefore)
        : rawBefore.status !== (request.source === 'reference' ? 'reference' : 'done'))
        || rawBefore.deletedAt || rawBefore.purgedAt || taskRevisionOf(rawBefore) !== request.taskRevision) return false;
    try { return same(historyRowLoadProjection(rawBefore, witness.preparedAt), witness.source); }
    catch { return false; }
};
const readDoneStatus = (value: unknown,
    validateField: (field: TaskDraftField, value: unknown) => boolean): NativeDoneTaskStatusEnvelope | null => {
    const envelope = detach(value, COMPLETION_BYTES);
    if (!isRecord(envelope) || !exact(envelope, ['request', 'prepared']) || !isRecord(envelope.prepared)) return null;
    const request = readDoneStatusRequest(envelope.request);
    const raw = envelope.prepared;
    const reference = request?.source === 'reference';
    const menu = reference && request.status !== 'next';
    if (!request || (request.status === 'done' || reference && request.status === 'reference') || (reference ? raw.version !== 2 : raw.version !== 1 && raw.version !== 2)
        || !exact(raw, ['version', 'kind', 'request', 'checklist', 'result', ...(raw.version === 2 ? [menu ? 'rawBeforeTask' : 'rawBefore'] : [])])
        || raw.kind !== (reference ? menu ? 'referenceStatus' : 'referenceNext' : 'doneStatus') || !same(raw.request, request)
        || !isRecord(raw.checklist) || !isRecord(raw.result) || !exact(raw.result, ['id']) || raw.result.id !== request.id) return null;
    const prepared = raw as unknown as NativePreparedDoneTaskStatus;
    const checklist = readPrepared({ request: prepared.checklist.request, prepared: prepared.checklist }, validateField);
    if (!checklist || checklist.kind !== 'save' || !isSave(checklist.request)
        || !validRawTask(checklist.witness.source, request.id) || checklist.witness.source.status !== (reference ? 'reference' : 'done')
        || taskRevisionOf(checklist.witness.source) !== request.taskRevision
        || !same(checklist.request, doneStatusSaveRequest(checklist.witness.source, request))
        || !same(checklist.result, prepared.result)) return null;
    if (!validHistoryRowEffect(checklist, request.id)
        || prepared.version === 2 && !validHistoryRowRawBefore(prepared.kind === 'referenceStatus' ? prepared.rawBeforeTask : prepared.rawBefore, request, checklist.witness)) return null;
    return envelope as NativeDoneTaskStatusEnvelope;
};

const readDoneCompletedAt = (value: unknown,
    validateField: (field: TaskDraftField, value: unknown) => boolean): NativeDoneTaskCompletedAtEnvelope | null => {
    const envelope = detach(value, COMPLETION_BYTES);
    if (!isRecord(envelope) || !exact(envelope, ['request', 'prepared']) || !isRecord(envelope.prepared)) return null;
    const request = readDoneCompletedAtRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || raw.version !== 2 || raw.kind !== 'doneCompletedAt'
        || !exact(raw, ['version', 'kind', 'request', 'rawBefore', 'checklist', 'result']) || !same(raw.request, request)
        || !isRecord(raw.checklist) || !isRecord(raw.result) || !exact(raw.result, ['id']) || raw.result.id !== request.id) return null;
    const prepared = raw as unknown as NativePreparedDoneTaskCompletedAt;
    const checklist = readPrepared({ request: prepared.checklist.request, prepared: prepared.checklist }, validateField);
    if (!checklist || checklist.kind !== 'save' || !isSave(checklist.request)
        || !validRawTask(checklist.witness.source, request.id) || checklist.witness.source.status !== 'done'
        || taskRevisionOf(checklist.witness.source) !== request.taskRevision
        || !same(checklist.request, completedAtSaveRequest(checklist.witness.source, request, 'doneCompletedAt'))
        || !same(checklist.result, prepared.result) || !validHistoryRowEffect(checklist, request.id)
        || !validHistoryRowRawBefore(prepared.rawBefore, request, checklist.witness)) return null;
    return envelope as NativeDoneTaskCompletedAtEnvelope;
};

const readArchiveCompletedAt = (value: unknown,
    validateField: (field: TaskDraftField, value: unknown) => boolean): NativeArchiveTaskCompletedAtEnvelope | null => {
    const envelope = detach(value, COMPLETION_BYTES);
    if (!isRecord(envelope) || !exact(envelope, ['request', 'prepared']) || !isRecord(envelope.prepared)) return null;
    const request = readDoneCompletedAtRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || raw.version !== 2 || raw.kind !== 'archiveCompletedAt'
        || !exact(raw, ['version', 'kind', 'request', 'rawBefore', 'checklist', 'result']) || !same(raw.request, request)
        || !isRecord(raw.checklist) || !isRecord(raw.result) || !exact(raw.result, ['id']) || raw.result.id !== request.id) return null;
    const prepared = raw as unknown as NativePreparedArchiveTaskCompletedAt;
    const checklist = readPrepared({ request: prepared.checklist.request, prepared: prepared.checklist }, validateField);
    if (!checklist || checklist.kind !== 'save' || !isSave(checklist.request)
        || !validRawTask(checklist.witness.source, request.id) || !isArchiveCompletedAtSource(checklist.witness.source)
        || taskRevisionOf(checklist.witness.source) !== request.taskRevision
        || !same(checklist.request, completedAtSaveRequest(checklist.witness.source, request, 'archiveCompletedAt'))
        || !same(checklist.result, prepared.result) || !validHistoryRowEffect(checklist, request.id)
        || !validHistoryRowRawBefore(prepared.rawBefore, request, checklist.witness, true)) return null;
    return envelope as NativeArchiveTaskCompletedAtEnvelope;
};

const readCancellation = (value: unknown,
    validateField: (field: TaskDraftField, value: unknown) => boolean): NativeChecklistCancellationEnvelope | null => {
    const envelope = detach(value);
    if (!isRecord(envelope) || !exact(envelope, ['request', 'prepared'])) return null;
    const prepared = readPrepared(envelope, validateField);
    return prepared && prepared.kind === 'save' && isSave(prepared.request)
        && prepared.request.intent === 'cancel' && isRecord(prepared.result)
        && 'cancellation' in prepared.result && isRecord(prepared.result.cancellation)
        ? envelope as NativeChecklistCancellationEnvelope : null;
};

const bindRawChecklistRows = (effect: PreparedChecklistEffect, data: AppData): PreparedChecklistRawBefore => ({
    tasks: effect.tasks.map((row) => ({ id: row.after.id, before: row.before === null ? null : (() => { const task = data.tasks.find((task) => task.id === row.after.id); return task ? rawReadTaskSnapshot(task) : null; })() })),
    projects: effect.projects.map((row) => ({ id: row.after.id, before: row.before === null ? null : data.projects.find((project) => project.id === row.after.id) ?? null })),
    sections: effect.sections.map((row) => ({ id: row.after.id, before: row.before === null ? null : data.sections?.find((section) => section.id === row.after.id) ?? null })),
});
const validOwnedChecklistRawBefore = (value: unknown, effect: PreparedChecklistEffect, at: string): value is PreparedChecklistRawBefore => {
    if (!isRecord(value) || !exact(value, ['tasks', 'projects', 'sections'])) return false;
    const binds = <T extends { id: string }>(raw: unknown, effects: Array<{ before: T | null; after: T }>,
        project: (value: unknown, id: string) => T | null): boolean => Array.isArray(raw) && raw.length === effects.length
        && new Set(raw.map((row) => isRecord(row) ? row.id : null)).size === raw.length
        && raw.every((row: unknown) => {
            if (!isRecord(row) || !exact(row, ['id', 'before']) || typeof row.id !== 'string') return false;
            const affected = effects.find((item) => item.after.id === row.id);
            if (!affected) return false;
            if (affected.before === null) return row.before === null;
            const before = project(row.before, row.id);
            return before !== null && same(before, affected.before);
        });
    return binds(value.tasks, effect.tasks, (row, id) => {
        if (!validRawTask(row, id)) return null;
        try { return historyRowLoadProjection(row, at); } catch { return null; }
    }) && binds(value.projects, effect.projects, (row, id) => isRecord(row) && row.id === id
        ? normalizeProjectLifecycleFields(row as unknown as Project) : null)
        && binds(value.sections, effect.sections, (row, id) => isRecord(row) && row.id === id ? row as unknown as Section : null);
};
const ownedChecklistState = (data: AppData, at: string): TaskStore => {
    const tasks = data.tasks.map((row) => historyRowLoadProjection(row, at));
    const projects = data.projects.map(normalizeProjectLifecycleFields), sections = data.sections ?? [], areas = data.areas ?? [];
    return { ...useTaskStore.getState(), _allTasks: tasks, tasks, _allProjects: projects, _allSections: sections, _allAreas: areas,
        _tasksById: new Map(tasks.map((row) => [row.id, row])), _projectsById: new Map(projects.map((row) => [row.id, row])),
        _sectionsById: new Map(sections.map((row) => [row.id, row])), _areasById: new Map(areas.map((row) => [row.id, row])), settings: data.settings };
};
const ownedRawBeforeMatches = (data: AppData, raw: PreparedChecklistRawBefore): boolean => {
    const binds = <T extends { id: string }>(rows: T[], captured: Array<{ id: string; before: T | null }>,
        equal: (left: T, right: T) => boolean) => captured.every((bound) => {
        const matches = rows.filter((row) => row.id === bound.id);
        return bound.before === null ? matches.length === 0 : matches.length === 1 && equal(matches[0], bound.before);
    });
    return binds(data.tasks, raw.tasks, sameOwnedRawTask) && binds(data.projects, raw.projects, same)
        && binds(data.sections ?? [], raw.sections, same);
};
const ownedChecklistAfterMatches = (data: AppData, effect: PreparedChecklistEffect): boolean => {
    const matches = <T extends { id: string }>(rows: T[], effects: Array<{ after: T }>, equal: (left: T, right: T) => boolean) => effects.every((affected) => {
        const current = rows.filter((row) => row.id === affected.after.id);
        return current.length === 1 && equal(current[0], affected.after);
    });
    return matches(data.tasks, effect.tasks, sameOwnedTaskAfter) && matches(data.projects, effect.projects, same)
        && matches(data.sections ?? [], effect.sections, same)
        && (effect.deviceIdToInitialize === null || data.settings.deviceId === effect.deviceIdToInitialize);
};
const validReferenceRawBefore = (raw: unknown, effect: PreparedChecklistEffect, at: string): raw is PreparedChecklistRawBefore => {
    if (!isRecord(raw) || !exact(raw, ['tasks', 'projects', 'sections']) || !Array.isArray(raw.tasks)
        || !Array.isArray(raw.projects) || !Array.isArray(raw.sections) || raw.projects.length || raw.sections.length
        || effect.projects.length || effect.sections.length || raw.tasks.length !== effect.tasks.length
        || effect.guards.reactivation !== null) return false;
    const ids = new Set<string>();
    return raw.tasks.every((row: unknown) => {
        if (!isRecord(row) || !exact(row, ['id', 'before']) || typeof row.id !== 'string' || ids.has(row.id)) return false;
        ids.add(row.id); const affected = effect.tasks.find((item) => item.after.id === row.id);
        if (!affected) return false;
        if (affected.before === null) return row.before === null;
        if (!validReferenceRawTask(row.before, row.id)) return false;
        try { return same(historyRowLoadProjection(row.before, at), affected.before); } catch { return false; }
    });
};
const readReferenceBackdate = (value: unknown,
    validateField: (field: TaskDraftField, value: unknown) => boolean): NativeReferenceTaskBackdateEnvelope | null => {
    const envelope = detach(value, COMPLETION_BYTES);
    if (!isRecord(envelope) || !exact(envelope, ['request', 'prepared']) || !isRecord(envelope.prepared)) return null;
    const request = readReferenceBackdateRequest(envelope.request); const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'kind', 'request', 'rawBefore', 'checklist', 'result'])
        || raw.version !== 2 || raw.kind !== 'referenceBackdate' || !same(raw.request, request)
        || !isRecord(raw.checklist) || !isRecord(raw.result) || !exact(raw.result, ['id']) || raw.result.id !== request.id) return null;
    const prepared = raw as unknown as NativePreparedReferenceTaskBackdate;
    const checklist = readPrepared({ request: prepared.checklist.request, prepared: prepared.checklist }, validateField);
    if (!checklist || checklist.kind !== 'save' || !isSave(checklist.request)
        || checklist.witness.source.status !== 'reference'
        || taskRevisionOf(checklist.witness.source) !== request.taskRevision
        || isTaskEditorTimeSpentEnabled(checklist.witness.settings) !== (request.timeSpentText !== null)
        || !same(checklist.request, referenceBackdateSaveRequest(checklist.witness.source, request))
        || !same(checklist.result, prepared.result)
        || !validReferenceRawBefore(prepared.rawBefore, checklist.effect, checklist.witness.preparedAt)) return null;
    return envelope as NativeReferenceTaskBackdateEnvelope;
};
const readReferenceDestination = (value: unknown,
    validateField: (field: TaskDraftField, value: unknown) => boolean): NativeReferenceTaskDestinationEnvelope | null => {
    const envelope = detach(value, COMPLETION_BYTES);
    if (!isRecord(envelope) || !exact(envelope, ['request', 'prepared']) || !isRecord(envelope.prepared)) return null;
    const request = readReferenceDestinationRequest(envelope.request); const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'kind', 'request', 'rawBefore', 'checklist', 'result'])
        || raw.version !== 2 || raw.kind !== 'referenceDestination' || !same(raw.request, request)
        || !isRecord(raw.checklist) || !isRecord(raw.result) || !exact(raw.result, ['id']) || raw.result.id !== request.id) return null;
    const prepared = raw as unknown as NativePreparedReferenceTaskDestination;
    const checklist = readPrepared({ request: prepared.checklist.request, prepared: prepared.checklist }, validateField);
    if (!checklist || checklist.kind !== 'save' || !isSave(checklist.request) || checklist.witness.source.status !== 'reference'
        || taskRevisionOf(checklist.witness.source) !== request.taskRevision
        || !referenceDestinationAvailable(request.destination, checklist.witness.lists)
        || !same(checklist.request, referenceDestinationSaveRequest(checklist.witness.source, request))
        || !same(checklist.result, prepared.result) || checklist.effect.tasks.length !== 1
        || checklist.effect.tasks[0].after.status !== 'reference' || checklist.witness.ids.length
        || checklist.witness.recurrenceProjection !== null
        || !validReferenceRawBefore(prepared.rawBefore, checklist.effect, checklist.witness.preparedAt)) return null;
    return envelope as NativeReferenceTaskDestinationEnvelope;
};
const readCompletion = (value: unknown,
    validateField: (field: TaskDraftField, value: unknown) => boolean): NativeTaskCompletionEnvelope | null => {
    const envelope = detach(value, COMPLETION_BYTES);
    if (!isRecord(envelope) || !exact(envelope, ['request', 'prepared']) || !isRecord(envelope.prepared)) return null;
    const request = readCompletionRequest(envelope.request) ?? readReferenceCompletionRequest(envelope.request) ?? readBoardCompletionRequest(envelope.request);
    const reference = request?.source === 'reference';
    const board = request?.source === 'board';
    const rawCompletion = reference || board;
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'kind', 'request', 'checklist', 'notice', 'result', ...(rawCompletion ? ['rawBefore'] : [])])
        || raw.version !== (rawCompletion ? 2 : 1) || raw.kind !== (board ? 'boardComplete' : reference ? 'referenceComplete' : 'complete') || !same(raw.request, request)
        || !isRecord(raw.checklist) || !isRecord(raw.notice) || !isRecord(raw.result)
        || !exact(raw.notice, ['message', 'undoLabel'])
        || !validCancelText(raw.notice.message, 512) || !validCancelText(raw.notice.undoLabel, 80)
        || !exact(raw.result, ['id', 'completion']) || !isRecord(raw.result.completion)
        || !exact(raw.result.completion, ['completedAt', 'undoEnabled', 'message', 'undoLabel'])) return null;
    const prepared = raw as unknown as NativePreparedTaskCompletion;
    const checklist = readPrepared({ request: prepared.checklist.request, prepared: prepared.checklist }, validateField, board);
    if (!checklist || checklist.kind !== 'save' || !isSave(checklist.request)
        || !(reference ? checklist.witness.source.status === 'reference'
            && !referenceContainerReadOnly(checklist.witness.source, checklist.witness.lists)
            && !isProjectedRecurringTaskId(checklist.witness.source.id) : board ? canCompleteNativeBoardTask(checklist.witness.source, checklist.witness.lists.projects, checklist.witness.lists.sections)
                : canCompleteNativeTask(checklist.witness.source, checklist.witness.lists.projects))
        || taskRevisionOf(checklist.witness.source) !== request.taskRevision
        || !same(checklist.request, reference ? referenceCompletionSaveRequest(checklist.witness.source, request.requestId)
            : completionSaveRequest(checklist.witness.source, request.requestId))
        || rawCompletion && (prepared.version !== 2 || !validReferenceRawBefore(prepared.rawBefore, checklist.effect, checklist.witness.preparedAt))) return null;
    const after = checklist.effect.tasks.find((row) => row.after.id === request.id)?.after;
    const result = prepared.result;
    return after && after.status === 'done' && typeof after.completedAt === 'string'
        && after.completedAt === checklist.witness.preparedAt
        && result.id === request.id && result.completion.completedAt === after.completedAt
        && result.completion.undoEnabled === true
        && result.completion.message === prepared.notice.message
        && result.completion.undoLabel === prepared.notice.undoLabel
        ? envelope as NativeTaskCompletionEnvelope : null;
};

const ownedCompletionChild = (completion: NativeTaskCompletionEnvelope): Task | null => {
    const created = completion.prepared.checklist.effect.tasks.filter((row) => row.before === null);
    return created.length === 1 && created[0].after.id !== completion.request.id ? created[0].after : null;
};
const sameSavedTask = (left: Task | undefined, right: Task): boolean =>
    Boolean(left) && samePreparedTask(left!, right);
const completionUndoDirect = (completion: NativeTaskCompletionEnvelope, witness: Witness): Partial<Task> => {
    const before = completion.prepared.checklist.witness.source;
    const restoreFocus = before.isFocusedToday === true && witness.focusCount < witness.focusLimit;
    return { status: before.status, isFocusedToday: restoreFocus, focusOrder: undefined };
};
const planCompletionUndo = (completion: NativeTaskCompletionEnvelope, witness: Witness): PreparedChecklistEffect => {
    const planned = plan('save', completion.prepared.checklist.request, witness, false, true);
    const child = ownedCompletionChild(completion);
    // A prior Today star makes even a no-star Undo result a cap-dependent
    // decision. Freeze and compare the count/limit at the atomic write boundary.
    const effect: PreparedChecklistEffect = completion.prepared.checklist.witness.source.isFocusedToday === true
        ? { ...planned.effect, guards: { ...planned.effect.guards,
            focusCount: witness.focusCount, focusLimit: witness.focusLimit,
            focusBoundary: witness.futureBoundary } }
        : planned.effect;
    if (!child) return effect;
    const frozen = witness.lists.tasks.find((row) => row.id === child.id);
    if (!frozen || !sameSavedTask(frozen, child) || frozen.deletedAt || frozen.purgedAt)
        throw new Error('Recurring follow-up changed');
    const tombstone: Task = { ...child, deletedAt: witness.preparedAt, updatedAt: witness.preparedAt,
        rev: nextRevision(child.rev), revBy: deviceId(witness) };
    return { ...effect, tasks: [...effect.tasks, { before: child, after: tombstone }] };
};
/** Exactly RN's delete-follow-up, moveTask, then conditional Focus update. */
const planRawCompletionUndo = (completion: NativeTaskCompletionEnvelope, witness: Witness): PreparedChecklistEffect => {
    const board = completion.prepared.kind === 'boardComplete';
    const child = ownedCompletionChild(completion);
    let lists = witness.lists;
    if (child) {
        const current = lists.tasks.find((row) => row.id === child.id);
        if (!current || current.deletedAt || current.purgedAt
            || !sameSavedTask(current, board ? child : historyRowLoadProjection(child, witness.preparedAt))) throw new Error('Recurring follow-up changed');
        const [tombstone] = planTaskMutations({ tasks: [current], state: {}, now: witness.preparedAt,
            deviceId: deviceId(witness), buildUpdates: (_task, context) => ({ deletedAt: context.now }) });
        lists = { ...lists, tasks: lists.tasks.map((row) => row.id === child.id ? tombstone : row) };
    }
    const moveWitness = board ? { ...witness, lists,
        direct: { status: completion.prepared.checklist.witness.source.status, isFocusedToday: false },
        directClears: ['focusOrder'] } : { ...witness, lists };
    const moved = plan('save', completion.prepared.checklist.request, moveWitness, false, true).effect;
    let tasks = lists.tasks.map((row) => moved.tasks.find((item) => item.after.id === row.id)?.after ?? row);
    const starred = completion.prepared.checklist.witness.source.isFocusedToday === true;
    if (starred && witness.focusCount < witness.focusLimit) {
        const source = tasks.find((row) => row.id === witness.source.id)!;
        const focused = plan('save', completion.prepared.checklist.request, { ...witness, source,
            lists: { ...lists, tasks }, direct: { isFocusedToday: true }, directClears: [] }, false, true).effect;
        tasks = tasks.map((row) => focused.tasks.find((item) => item.after.id === row.id)?.after ?? row);
    }
    return { ...moved, sourceBefore: witness.source, tasks: changedRows(witness.lists.tasks, tasks),
        guards: { ...moved.guards, ...(starred ? { focusCount: witness.focusCount,
            focusLimit: witness.focusLimit, focusBoundary: witness.futureBoundary } : {}) } };
};
const readCompletionUndo = (value: unknown,
    validateField: (field: TaskDraftField, value: unknown) => boolean): NativeTaskCompletionUndoEnvelope | null => {
    const envelope = detach(value, COMPLETION_UNDO_BYTES);
    if (!isRecord(envelope) || !exact(envelope, ['request', 'prepared']) || !isRecord(envelope.prepared)) return null;
    const request = readCompletionUndoRequest(envelope.request);
    const raw = envelope.prepared;
    const completion = readCompletion(raw.completion, validateField);
    const reference = completion?.prepared.kind === 'referenceComplete';
    const board = completion?.prepared.kind === 'boardComplete';
    const rawCompletion = reference || board;
    if (!request || !exact(raw, ['version', 'kind', 'request', 'completion', 'witness', 'effect', 'result', ...(rawCompletion ? ['rawBefore'] : [])])
        || raw.version !== (rawCompletion ? 2 : 1) || raw.kind !== (board ? 'boardCompleteUndo' : reference ? 'referenceCompleteUndo' : 'undo') || !same(raw.request, request)
        || !completion || !same(raw.completion, completion) || request.completionRequestId !== completion.request.requestId
        || !isRecord(raw.witness) || !isRecord(raw.effect) || !isRecord(raw.result)
        || !exact(raw.result, ['id'])) return null;
    const prepared = raw as unknown as NativePreparedTaskCompletionUndo;
    const witness = prepared.witness;
    const completed = completion.prepared.checklist.effect.tasks.find((row) => row.after.id === completion.request.id)?.after;
    const owned = ownedCompletionChild(completion);
    if (!completed || !isRecord(witness.source) || !validRawTask(witness.source, completion.request.id)
        || !isRecord(witness.lists) || !exact(witness as unknown as Record<string, unknown>, [
            'source', 'lists', 'settings', 'preparedAt', 'preparedLocalDay', 'preparedOffsetMinutes',
            'boundaryOffsetMinutes', 'futureBoundary', 'deviceIdBefore', 'deviceIdToInitialize',
            'recurrenceProjection', 'ids', 'directClears', 'direct', 'focusCount', 'focusLimit',
        ]) || !exact(witness.lists, ['tasks', 'projects', 'sections', 'areas'])
        || !Array.isArray(witness.lists.tasks) || !Array.isArray(witness.lists.projects)
        || !Array.isArray(witness.lists.sections) || !Array.isArray(witness.lists.areas)
        || !witness.lists.tasks.every((row: unknown) => isRecord(row) && validRawTask(row, row.id as string))
        || !isRecord(witness.settings) || !isRecord(witness.direct)
        || !Array.isArray(witness.directClears) || !validClears(witness.direct, witness.directClears)
        || !Array.isArray(witness.ids) || witness.ids.length !== 0 || witness.recurrenceProjection !== null
        || witness.source.deletedAt || witness.source.purgedAt || witness.source.status !== 'done'
        || witness.source.completedAt !== completed.completedAt
        || (witness.source.rev ?? 0) < (completed.rev ?? 0)
        || isStatusListTaskReadOnly(witness.source, witness.lists.projects)
        || witness.lists.tasks.filter((row) => row.id === witness.source.id).length !== 1
        || !same(witness.lists.tasks.find((row) => row.id === witness.source.id), witness.source)
        || (owned && (witness.lists.tasks.filter((row) => row.id === owned.id).length !== 1
            || !sameSavedTask(witness.lists.tasks.find((row) => row.id === owned.id), reference ? historyRowLoadProjection(owned, witness.preparedAt) : owned)))
        || typeof witness.preparedAt !== 'string' || !Number.isFinite(Date.parse(witness.preparedAt))
        || new Date(witness.preparedAt).toISOString() !== witness.preparedAt
        || typeof witness.preparedLocalDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(witness.preparedLocalDay)
        || !Number.isInteger(witness.preparedOffsetMinutes) || Math.abs(witness.preparedOffsetMinutes) > 840
        || !Number.isInteger(witness.boundaryOffsetMinutes) || Math.abs(witness.boundaryOffsetMinutes) > 840
        || new Date(Date.parse(witness.preparedAt) - witness.preparedOffsetMinutes * 60_000).toISOString().slice(0, 10)
            !== witness.preparedLocalDay
        || new Date(Date.parse(`${witness.preparedLocalDay}T23:59:59.999Z`)
            + witness.boundaryOffsetMinutes * 60_000).toISOString() !== witness.futureBoundary
        || witness.deviceIdBefore !== (witness.settings.deviceId ?? null)
        || (witness.deviceIdBefore === null
            ? typeof witness.deviceIdToInitialize !== 'string' || !UUID.test(witness.deviceIdToInitialize)
            : witness.deviceIdToInitialize !== null)
        || !Number.isSafeInteger(witness.focusCount) || witness.focusCount < 0
        || !Number.isSafeInteger(witness.focusLimit) || witness.focusLimit < 1
        || witness.focusLimit !== normalizeFocusTaskLimit((witness.settings.gtd as { focusTaskLimit?: number } | undefined)?.focusTaskLimit)
        || (reference && referenceContainerReadOnly(witness.source, witness.lists))
        || (board && !boardUndoContainerMatches(completion, witness.source, witness.lists))
        || !same(restoreClears(witness.direct, witness.directClears), reference ? { status: 'reference' } : completionUndoDirect(completion, witness))
        || prepared.result.id !== witness.source.id) return null;
    try {
        return same(rawCompletion ? planRawCompletionUndo(completion, witness) : planCompletionUndo(completion, witness), prepared.effect)
            && (!rawCompletion || prepared.version === 2 && validReferenceRawBefore(prepared.rawBefore, prepared.effect, witness.preparedAt))
            ? envelope as NativeTaskCompletionUndoEnvelope : null;
    } catch { return null; }
};

const readCancellationUndoProof = (value: unknown,
    validateField: (field: TaskDraftField, value: unknown) => boolean,
    owned?: { cancel: NativeOwnedCompleteChecklistCancellation; identity: unknown }): NativeTaskCancellationUndoEnvelope | NativeOwnedCompleteCancellationUndoEnvelope | null => {
    const envelope = detach(value, owned ? 24 * 1024 * 1024 : LIMIT_BYTES);
    if (!isRecord(envelope) || !exact(envelope, ['request', 'prepared']) || !isRecord(envelope.prepared)) return null;
    const request = readUndoRequest(envelope.request);
    const raw = envelope.prepared;
    const cancel = owned?.cancel ?? readCancellation(raw.cancel, validateField);
    if (!request || !exact(raw, ['version', 'kind', 'request', 'cancel', 'witness', 'effect', 'result', ...(owned ? ['rawBefore'] : [])])
        || raw.version !== (owned ? 2 : 1) || raw.kind !== 'undo' || !same(raw.request, request)
        || !cancel || request.cancelRequestId !== cancel.request.requestId
        || !same(raw.cancel, owned ? owned.identity : cancel) || !isRecord(raw.witness) || !isRecord(raw.effect)
        || !isRecord(raw.result) || !exact(raw.result, ['id'])) return null;
    if (owned && (request.requestId.length !== 36 || request.cancelRequestId.length !== 36)) return null;
    const prepared = raw as unknown as NativePreparedTaskCancellationUndo;
    const witness = prepared.witness;
    const cancelled = cancel.prepared.effect.tasks.find((row) => row.after.id === cancel.request.id)?.after;
    if (!cancelled || !isRecord(witness.source) || !isRecord(witness.lists)
        || !exact(witness as unknown as Record<string, unknown>, [
            'source', 'lists', 'settings', 'preparedAt', 'preparedLocalDay', 'preparedOffsetMinutes',
            'boundaryOffsetMinutes', 'futureBoundary', 'deviceIdBefore', 'deviceIdToInitialize',
            'recurrenceProjection', 'ids', 'directClears', 'direct', 'focusCount', 'focusLimit',
        ]) || !exact(witness.lists, ['tasks', 'projects', 'sections', 'areas'])
        || !Array.isArray(witness.lists.tasks) || !Array.isArray(witness.lists.projects)
        || !Array.isArray(witness.lists.sections) || !Array.isArray(witness.lists.areas)
        || !isRecord(witness.settings) || !isRecord(witness.direct)
        || !Array.isArray(witness.directClears) || !validClears(witness.direct, witness.directClears)
        || !Array.isArray(witness.ids) || witness.ids.length !== 0 || witness.recurrenceProjection !== null
        || witness.source.id !== cancel.request.id || witness.source.deletedAt || witness.source.purgedAt
        || witness.source.status !== 'archived' || witness.source.cancelledAt !== cancelled.cancelledAt
        || (witness.source.rev ?? 0) < (cancelled.rev ?? 0)
        || isStatusListTaskReadOnly(witness.source, witness.lists.projects)
        || witness.lists.tasks.filter((row) => row.id === witness.source.id).length !== 1
        || !same(witness.lists.tasks.find((row) => row.id === witness.source.id), witness.source)
        || typeof witness.preparedAt !== 'string' || !Number.isFinite(Date.parse(witness.preparedAt))
        || new Date(witness.preparedAt).toISOString() !== witness.preparedAt
        || typeof witness.preparedLocalDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(witness.preparedLocalDay)
        || !Number.isInteger(witness.preparedOffsetMinutes) || Math.abs(witness.preparedOffsetMinutes) > 840
        || !Number.isInteger(witness.boundaryOffsetMinutes) || Math.abs(witness.boundaryOffsetMinutes) > 840
        || new Date(Date.parse(witness.preparedAt) - witness.preparedOffsetMinutes * 60_000).toISOString().slice(0, 10)
            !== witness.preparedLocalDay
        || new Date(Date.parse(`${witness.preparedLocalDay}T23:59:59.999Z`)
            + witness.boundaryOffsetMinutes * 60_000).toISOString() !== witness.futureBoundary
        || witness.deviceIdBefore !== (witness.settings.deviceId ?? null)
        || (witness.deviceIdBefore === null
            ? typeof witness.deviceIdToInitialize !== 'string' || !UUID.test(witness.deviceIdToInitialize)
            : witness.deviceIdToInitialize !== null)
        || !Number.isSafeInteger(witness.focusCount) || witness.focusCount < 0
        || !Number.isSafeInteger(witness.focusLimit) || witness.focusLimit < 1
        || !same(restoreClears(witness.direct, witness.directClears),
            taskCancellationRestoreFields(cancel.prepared.witness.source))
        || prepared.result.id !== witness.source.id) return null;
    try {
        const planned = plan('save', cancel.request, witness, false, true, owned ? ownedChecklistSelection : undefined);
        return same(planned.effect, prepared.effect) && same(planned.result, prepared.result)
            && (!owned || validOwnedChecklistRawBefore(raw.rawBefore, planned.effect, witness.preparedAt))
            ? envelope as NativeTaskCancellationUndoEnvelope | NativeOwnedCompleteCancellationUndoEnvelope : null;
    } catch { return null; }
};
const readPreparedUndo = (value: unknown, validateField: (field: TaskDraftField, value: unknown) => boolean): NativeTaskCancellationUndoEnvelope | null =>
    readCancellationUndoProof(value, validateField) as NativeTaskCancellationUndoEnvelope | null;

const rawWriteEffect = (envelope: NativeRawWriteEnvelope): PreparedChecklistEffect => (envelope.prepared.kind === 'referenceCompleteUndo' || envelope.prepared.kind === 'boardCompleteUndo')
    ? envelope.prepared.effect : envelope.prepared.checklist.effect;
const rawWriteWitness = (envelope: NativeRawWriteEnvelope): Witness => (envelope.prepared.kind === 'referenceCompleteUndo' || envelope.prepared.kind === 'boardCompleteUndo')
    ? envelope.prepared.witness : envelope.prepared.checklist.witness;
const historyRawSource = (prepared: NativeBoundHistoryRowEnvelope['prepared']): Task =>
    prepared.kind === 'referenceStatus' ? prepared.rawBeforeTask : prepared.rawBefore;
const rawWritePrefix = (envelope: NativeHistoryRowEnvelope | NativeRawReferenceEnvelope): string => {
    switch (envelope.prepared.kind) {
        case 'referenceNext': return 'referenceTaskNext';
        case 'referenceStatus': return 'referenceTaskStatus';
        case 'referenceComplete': return 'referenceTaskCompletion';
        case 'referenceCompleteUndo': return 'referenceTaskCompletionUndo';
        case 'boardComplete': return 'boardTaskCompletion';
        case 'boardCompleteUndo': return 'boardTaskCompletionUndo';
        case 'referenceBackdate': return 'referenceTaskBackdate';
        case 'referenceDestination': return 'referenceTaskDestination';
        case 'doneStatus': return 'doneTaskStatus';
        case 'doneCompletedAt': return 'doneTaskCompletedAt';
        case 'archiveCompletedAt': return 'archiveTaskCompletedAt';
    }
};

export type NativeTaskChecklistSaveDependencies = {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    validateField: (field: TaskDraftField, value: unknown) => boolean;
    isReadOnly: (task: Task) => boolean;
    language: () => string;
    receipts: NativeRequestReceipts;
};
function createTaskChecklistSaveFactory(deps: NativeTaskChecklistSaveDependencies) {
    const historyRowSaves = createAreaSaveGuard(deps.save);
    // A failed save gates fresh writes, so only one owned raw overlay is retained.
    let pendingHistoryRow: { envelope: NativeRawWriteEnvelope;
        adapter: ReturnType<typeof getStorageAdapter>;
        boundary: PreparedNativeSaveBoundary | undefined } | null = null;
    const checkReferenceAtomicAuthority = (envelope: NativeRawReferenceEnvelope, authority: PreparedAreaAuthority): NativeHostResult<null> => {
        const prepared = envelope.prepared; const effect = rawWriteEffect(envelope); const witness = rawWriteWitness(envelope);
        const data = authority.snapshot;
        const board = prepared.kind === 'boardComplete' || prepared.kind === 'boardCompleteUndo';
        if (board) {
            if (!sameBoardCompletionContainer(witness.source, witness.lists, data)
                || prepared.kind === 'boardCompleteUndo' && !sameBoardCompletionContainer(prepared.completion.prepared.checklist.witness.source, witness.lists, data))
                return fail('STALE_REVISION', 'Board completion container changed since preparation');
        }
        for (const bound of prepared.rawBefore.tasks) {
            const current = data.tasks.filter((row) => row.id === bound.id);
            if (bound.before === null ? current.length !== 0 : current.length !== 1 || !rawReadTaskSnapshot(current[0]) || !sameRawHistoryRowTask(rawReadTaskSnapshot(current[0])!, bound.before))
                return fail('STALE_REVISION', 'Reference affected saved row changed');
        }
        if (prepared.kind === 'referenceDestination') {
            if (!referenceDestinationAvailable(prepared.request.destination, { projects: data.projects, areas: data.areas ?? [] }))
                return fail('STALE_REVISION', 'Reference destination is no longer available');
            // This filing action binds only its source/retained Section, never
            // unrelated Sections. Its identity and parent must survive retries.
            const sectionId = witness.source.sectionId;
            if (sectionId && !same(witness.lists.sections.find((row) => row.id === sectionId),
                (data.sections ?? []).find((row) => row.id === sectionId)))
                return fail('STALE_REVISION', 'Reference source Section changed since preparation');
        }
        try {
            const lists: Lists = { tasks: data.tasks.map((row) => historyRowLoadProjection(row, witness.preparedAt)),
                projects: data.projects.map(normalizeProjectLifecycleFields), sections: data.sections ?? [], areas: data.areas ?? [] };
            const source = lists.tasks.find((row) => row.id === witness.source.id);
            const memory = useTaskStore.getState()._tasksById.get(witness.source.id);
            if (!source || !memory || source.deletedAt || source.purgedAt || deps.isReadOnly(memory)
                || (board ? !boardCompletionContainer(source, lists) : referenceContainerReadOnly(source, lists))) return fail('STALE_REVISION', 'Reference source is no longer writable');
            const currentWitness = { ...witness, source, lists, settings: data.settings,
                deviceIdBefore: data.settings.deviceId ?? null,
                focusCount: countFocusedTasksBeforeBoundary(lists.tasks, witness.futureBoundary),
                focusLimit: normalizeFocusTaskLimit(data.settings.gtd?.focusTaskLimit) };
            const current = prepared.kind === 'boardCompleteUndo' || prepared.kind === 'referenceCompleteUndo'
                ? planRawCompletionUndo(prepared.completion, currentWitness)
                : plan('save', prepared.checklist.request, currentWitness, false, false, undefined, prepared.kind === 'boardComplete').effect;
            return same(current, effect) ? { ok: true, value: null } : fail('STALE_REVISION', 'Reference guards changed since preparation');
        } catch { return fail('STALE_REVISION', 'Reference destination or recurring follow-up changed'); }
    };
    const checkHistoryRowAuthority = (envelope: NativeRawWriteEnvelope,
    authority: PreparedAreaAuthority): NativeHostResult<null> => {
        if (envelope.prepared.kind === 'referenceComplete' || envelope.prepared.kind === 'referenceCompleteUndo' || envelope.prepared.kind === 'boardComplete' || envelope.prepared.kind === 'boardCompleteUndo' || envelope.prepared.kind === 'referenceBackdate' || envelope.prepared.kind === 'referenceDestination')
            return checkReferenceAtomicAuthority(envelope as NativeRawReferenceEnvelope, authority);
        const history = envelope as NativeBoundHistoryRowEnvelope;
        const prepared = history.prepared;
        const reference = prepared.kind === 'referenceNext' || prepared.kind === 'referenceStatus';
        const data = authority.snapshot;
        const rawRows = data.tasks.filter((row) => row.id === history.request.id);
        const current = rawRows.length === 1 ? rawRows[0] : null;
        const state = useTaskStore.getState();
        const task = state._tasksById.get(history.request.id);
        if (!current || !(prepared.kind === 'referenceStatus' ? rawReadTaskSnapshot(current) && sameRawHistoryRowTask(rawReadTaskSnapshot(current)!, historyRawSource(prepared)) : sameRawHistoryRowTask(current, historyRawSource(prepared)))
            || !validHistoryRowSource(current, prepared.checklist.request) || current.deletedAt || current.purgedAt
            || (isReferenceNextRequest(prepared.checklist.request) && hasPurgedReferenceParent(current, data.projects))
            || (prepared.kind === 'referenceStatus' && referenceContainerReadOnly(current, { projects: data.projects, sections: data.sections ?? [] }))
            || !task || (!isArchiveCompletedAtRequest(prepared.checklist.request)
                && (deps.isReadOnly(task) || isStatusListTaskReadOnly(current, data.projects))))
            return fail('STALE_REVISION', `Saved ${reference ? 'Reference' : 'Done'} task is no longer the prepared writable source`);
        // Replan against current normalized lists at the frozen clock, retaining
        // membership, order, settings, selected container and assignment guards.
        try {
            const witness = prepared.checklist.witness;
            const currentWitness: Witness = { ...witness,
                source: historyRowLoadProjection(current, witness.preparedAt),
                lists: { tasks: data.tasks.map((row) => historyRowLoadProjection(row, witness.preparedAt)),
                    projects: data.projects.map(normalizeProjectLifecycleFields),
                    sections: data.sections ?? [], areas: data.areas ?? [] },
                settings: data.settings, deviceIdBefore: data.settings.deviceId ?? null };
            if (isReferenceOperation(prepared.checklist.request)) {
                // The hidden Reference star can become a counted Next slot.
                // Recompute from the complete durable task state, including on
                // an owned save retry; page/filter state is never authority.
                currentWitness.focusCount = countFocusedTasksBeforeBoundary(currentWitness.lists.tasks, witness.futureBoundary);
                currentWitness.focusLimit = normalizeFocusTaskLimit(data.settings.gtd?.focusTaskLimit);
                const guards = prepared.checklist.effect.guards;
                if (guards.focusCount !== null && (guards.focusCount !== currentWitness.focusCount
                    || guards.focusLimit !== currentWitness.focusLimit || guards.focusBoundary !== witness.futureBoundary
                    || currentWitness.focusCount >= currentWitness.focusLimit))
                    return fail('STALE_REVISION', 'Reference Next Focus capacity changed since preparation');
            }
            return same(plan('save', prepared.checklist.request, currentWitness).effect, prepared.checklist.effect)
                ? { ok: true, value: null } : fail('STALE_REVISION', `${reference ? 'Reference Next' : 'Done status'} guards changed since preparation`);
        } catch { return fail('STALE_REVISION', `${reference ? 'Reference Next' : 'Done status'} destination changed since preparation`); }
    };
    const applyHistoryRowOverlay = async (envelope: NativeRawWriteEnvelope, authority: PreparedAreaAuthority) => {
        if (envelope.prepared.kind === 'referenceComplete' || envelope.prepared.kind === 'referenceCompleteUndo' || envelope.prepared.kind === 'boardComplete' || envelope.prepared.kind === 'boardCompleteUndo' || envelope.prepared.kind === 'referenceBackdate' || envelope.prepared.kind === 'referenceDestination')
            return useTaskStore.getState().commitPreparedChecklistEffect(rawWriteEffect(envelope),
                { requireBefore: true, authority, rawBefore: envelope.prepared.rawBefore });
        const history = envelope as NativeBoundHistoryRowEnvelope; const effect = history.prepared.checklist.effect;
        if (history.prepared.kind === 'referenceStatus') return useTaskStore.getState().commitPreparedChecklistEffect(effect,
            { requireBefore: true, authority, rawBefore: { tasks: [{ id: history.request.id, before: history.prepared.rawBeforeTask }], projects: [], sections: [] } });
        return useTaskStore.getState().commitPreparedTaskDraftV2({ request: { id: history.request.id },
            deviceIdBefore: effect.deviceIdBefore, deviceIdToInitialize: effect.deviceIdToInitialize,
            effect: { task: { before: historyRawSource(history.prepared), after: effect.tasks[0].after } } }, authority);
    };
    const historyRowReceipts = createNativeRequestReceipts({ save: async (requestId) => {
        const pending = pendingHistoryRow;
        if (!pending || pending.envelope.request.requestId !== requestId)
            return fail('SAVE_FAILED', 'Done status has no owned raw save');
        const action = pending.envelope.prepared.kind.startsWith('reference') ? 'Reference change' : 'Done status';
        if (useTaskStore.getState().persistenceFailure) {
            if (!historyRowSaves.mayApply(pending.envelope, pending.adapter))
                return fail('SAVE_FAILED', `${action} has an unrelated persistence failure`);
            const read = await readAreaDurableData(true, true);
            if (!read.ok) return read;
            if (read.value.adapter !== pending.adapter)
                return fail('STALE_REVISION', `${action} storage changed before retry`);
            const checked = checkHistoryRowAuthority(pending.envelope, read.value.authority);
            if (!checked.ok) return checked;
            const applied = await applyHistoryRowOverlay(pending.envelope, read.value.authority);
            if (!applied.success || applied.outcome !== 'applied')
                return fail('STALE_REVISION', applied.error ?? `${action} raw retry was superseded`);
            pending.boundary = read.value.authority.saveBoundary;
        }
        // The receipt engine has registered this exact reply before this flush.
        // Flush its raw effect directly; generic retryPersistence projects memory.
        const saved = await historyRowSaves.finish(pending.envelope, pending.adapter, false, pending.boundary);
        if (saved.ok) pendingHistoryRow = null;
        return saved;
    } });
    const readHistoryRowSource = (input: unknown, archived = false, reference = false): NativeHostResult<Task> => {
        const ready = deps.readiness();
        if (!ready.ok) return ready;
        const rowLabel = archived ? 'Archive' : reference ? 'Reference' : 'Done';
        const detached = detach(input);
        if (!isRecord(detached) || !exact(detached, ['id', 'taskRevision'])
            || typeof detached.id !== 'string' || !detached.id.trim() || detached.id.length > 500
            || typeof detached.taskRevision !== 'string' || !detached.taskRevision || detached.taskRevision.length > 200)
            return fail('INVALID_INPUT', `A displayed ${rowLabel} task ID and revision are required`);
        const state = useTaskStore.getState();
        const task = state._tasksById.get(detached.id);
        if (!task || task.deletedAt || task.purgedAt || (archived ? !isArchiveCompletedAtSource(task)
            : task.status !== (reference ? 'reference' : 'done') || isProjectedRecurringTaskId(task.id)))
            return fail('TASK_NOT_FOUND', `${rowLabel} task not found`);
        if (taskRevisionOf(task) !== detached.taskRevision) return fail('STALE_REVISION', `Task changed since the ${rowLabel} row was shown`);
        if (!archived && (deps.isReadOnly(task) || isStatusListTaskReadOnly(task, state._allProjects)
            || reference && hasPurgedReferenceParent(task, state._allProjects)))
            return fail('INVALID_INPUT', `${rowLabel} task is read-only`);
        return { ok: true, value: task };
    };
    const commitHistoryRowWrite = async <T extends { id: string }>(envelope: (NativeHistoryRowEnvelope | NativeRawReferenceEnvelope) & { prepared: { result: T } }): Promise<NativeHostResult<T>> => {
        const ready = deps.readiness();
        if (!ready.ok) return ready;
        const action = envelope.prepared.kind.startsWith('reference') ? 'Reference change' : 'Done status';
        const payload = canonicalJSON([rawWritePrefix(envelope), envelope]);
        const alreadySaved = historyRowReceipts.saved<T>(envelope.request.requestId, payload);
        if (alreadySaved) return alreadySaved.ok && !same(alreadySaved.value, envelope.prepared.result)
            ? fail('INVALID_INPUT', `Saved ${action} result does not match its journal`) : alreadySaved;
        // Development v1 journals never bound the raw source. Saved v1
        // receipts remain authoritative; an uncommitted v1 cannot infer it.
        if (envelope.prepared.version !== 2)
            return fail('SAVE_FAILED', 'Uncommitted Done status journal has no raw source binding');
        const bound = envelope as NonNullable<typeof pendingHistoryRow>['envelope'];
        let prewriteFailure: { ok: false; error: { code: 'SAVE_FAILED'; message: string } } | null = null;
        const notLanded = (message: string): NativeHostResult<never> => {
            prewriteFailure = { ok: false, error: { code: 'SAVE_FAILED', message } };
            // SAVE_FAILED means landed to the receipt engine. A read failure
            // must delete its reservation, then keep the public error code.
            return { ok: false, error: { code: 'ACTION_FAILED', message } };
        };
        const confirmed = await historyRowReceipts.run(envelope.request.requestId, payload, async () => {
            if (bound.prepared.kind === 'referenceCompleteUndo' || bound.prepared.kind === 'boardCompleteUndo') {
                const completion = bound.prepared.completion;
                const confirmed = historyRowReceipts.saved<NativeTaskCompletionResult>(completion.request.requestId, canonicalJSON([completion.prepared.kind === 'boardComplete' ? 'boardTaskCompletion' : 'referenceTaskCompletion', completion]));
                if (!confirmed?.ok || !same(confirmed.value, completion.prepared.result)) return fail('STALE_REVISION', 'Completion has no saved request receipt');
            }
            if (useTaskStore.getState().persistenceFailure)
                return notLanded(`${action} has an unresolved persistence failure`);
            const read = await readAreaDurableData(false, true);
            if (!read.ok) return read.error.code === 'SAVE_FAILED' ? notLanded(read.error.message) : read;
            const checked = checkHistoryRowAuthority(bound, read.value.authority);
            if (!checked.ok) return checked;
            const applied = await applyHistoryRowOverlay(bound, read.value.authority);
            if (!applied.success || applied.outcome !== 'applied')
                return fail('STALE_REVISION', applied.error ?? `Prepared ${action} conflicts with current data`);
            pendingHistoryRow = { envelope: bound, adapter: read.value.adapter, boundary: read.value.authority.saveBoundary };
            return { ok: true, value: envelope.prepared.result };
        });
        if (prewriteFailure) return prewriteFailure;
        if (confirmed.ok && !same(confirmed.value, envelope.prepared.result))
            return fail('INVALID_INPUT', `Saved ${action} result does not match its journal`);
        if (confirmed.ok) {
            try {
                if (envelope.prepared.kind === 'referenceNext') {
                    logInfo('Native Reference Task Next confirmed', { scope: 'native-host', category: 'storage',
                        context: { releaseCheck: 'v1.3.4/ios-reference-next', outcome: 'moved' } });
                } else if (envelope.prepared.kind === 'referenceStatus') {
                    logInfo('Native Reference Task status confirmed', { scope: 'native-host', category: 'storage',
                        context: { releaseCheck: 'v1.3.4/ios-reference-status', outcome: 'moved' } });
                } else if (envelope.prepared.kind === 'referenceComplete' || envelope.prepared.kind === 'referenceCompleteUndo') {
                    logInfo('Native Reference Task completion confirmed', { scope: 'native-host', category: 'storage',
                        context: { releaseCheck: 'v1.3.4/ios-reference-completion', outcome: envelope.prepared.kind === 'referenceComplete' ? 'completed' : 'undone' } });
                } else if (envelope.prepared.kind === 'referenceBackdate') {
                    logInfo('Native Reference Task backdated completion confirmed', { scope: 'native-host', category: 'storage',
                        context: { releaseCheck: 'v1.3.4/ios-reference-backdate', outcome: 'completed' } });
                } else if (envelope.prepared.kind === 'referenceDestination') {
                    logInfo('Native Reference Task destination confirmed', { scope: 'native-host', category: 'storage',
                        context: { releaseCheck: 'v1.3.4/ios-reference-destination', outcome: 'moved' } });
                } else if (envelope.prepared.kind !== 'boardComplete' && envelope.prepared.kind !== 'boardCompleteUndo') {
                    logInfo(envelope.prepared.kind === 'doneStatus' ? 'Native Done Task status confirmed'
                        : envelope.prepared.kind === 'doneCompletedAt' ? 'Native Done completion time confirmed' : 'Native Archive completion time confirmed', { scope: 'native-host', category: 'storage',
                        context: { releaseCheck: envelope.prepared.kind === 'doneStatus'
                            ? 'v1.3.4/ios-done-task-status' : envelope.prepared.kind === 'doneCompletedAt'
                                ? 'v1.3.4/ios-done-completion-time' : 'v1.3.4/ios-archive-completion-time', outcome: 'confirmed' } });
                }
            }
            catch { /* Diagnostics cannot invalidate a durable acknowledgment. */ }
        }
        return confirmed;
    };
    const prepareChecklist = (kind: 'save' | 'reset', input: unknown, selection?: ChecklistSelection,
        durable?: { data: AppData; at: string }, boardCompletion = false): NativeHostResult<NativeChecklistPreparation | { kind: 'prepared'; prepared: NativePreparedOwnedCompleteChecklistSave }
            | { kind: 'noop'; prepared: NativeOwnedCompleteChecklistNoop }> => {
        const ready = deps.readiness();
        if (!ready.ok) return ready;
        const request = (selection?.readRequest ?? readRequest)(input, deps.validateField);
        if (!request || kind !== (isSave(request) ? 'save' : 'reset')) {
            return fail('INVALID_INPUT', 'A bounded checklist request and lowercase UUID are required');
        }
        const state = durable ? ownedChecklistState(durable.data, durable.at) : useTaskStore.getState();
        const task = state._tasksById.get(request.id);
        if (!task || task.deletedAt || task.purgedAt) return fail('TASK_NOT_FOUND', 'Task not found');
        if (!isArchiveCompletedAtRequest(request) && (deps.isReadOnly(task) || isStatusListTaskReadOnly(task, state._allProjects))) {
            return fail('INVALID_INPUT', 'Task is read-only while its project is archived or deleted');
        }
        if (isReferenceOperation(request) && (hasPurgedReferenceParent(task, state._allProjects)
            || isReferenceMenuRequest(request) && referenceContainerReadOnly(task, { projects: state._allProjects, sections: state._allSections })))
            return fail('INVALID_INPUT', 'Reference task is read-only');
        if (isSave(request)) {
            if (isHistoryRowRequest(request) && !validHistoryRowSource(task, request))
                return fail('INVALID_INPUT', 'Only a saved Done row can change status');
            if (request.intent === 'cancel' && !canCancelNativeTask(task, state._allProjects, deps.isReadOnly(task)))
                return fail('INVALID_INPUT', 'Task cannot be cancelled');
            if (request.intent === 'skip' && !canSkipNativeTaskOccurrence(task, state._allProjects, deps.isReadOnly(task)))
                return fail('INVALID_INPUT', 'Task cannot skip an occurrence');
            if (!validNativeTaskDraftBases(task, draftRequest(request))
                || !same(toChecklist(task.checklist), request.checklist.base)) {
                return fail('STALE_REVISION', 'Task changed while editing');
            }
            if ((request.patch.status === 'reference' || task.status === 'reference')
                && (request.patch.priority || request.patch.timeEstimate)) {
                return fail('INVALID_INPUT', 'Reference task cannot set priority or time estimate');
            }
            if (request.patch.projectId && !state._allProjects.some((project) =>
                project.id === request.patch.projectId && isSelectableProjectForTaskAssignment(project))) {
                return fail('INVALID_INPUT', 'Project is not available');
            }
        } else {
            if (!same(toChecklist(task.checklist), request.checklistBase)) {
                return fail('STALE_REVISION', 'Checklist changed while editing');
            }
            if (request.checklistBase.length === 0) return { ok: true, value: { kind: 'unchanged', result: resetResult(task) } };
        }
        try {
            const preparedAt = durable?.at ?? new Date().toISOString();
            const boundary = futureBoundary(preparedAt);
            const device = ensureDeviceId(state.settings);
            const direct = isSave(request) ? directSaveUpdates(task, request, preparedAt, selection, boardCompletion) : {};
            if (!direct) return fail('INVALID_INPUT', 'Checklist edit cannot produce a task update');
            if (isSave(request) && request.intent === 'skip'
                && !canSkipRecurringTaskOccurrence({ ...task, ...direct })) {
                return fail('INVALID_INPUT', resolveI18nText(getTranslator(deps.language()), 'task.skipOccurrenceSaveFirst'));
            }
            const source = JSON.parse(JSON.stringify(task)) as Task;
            const settings = JSON.parse(JSON.stringify({ deviceId: state.settings.deviceId,
                gtd: { autoArchiveDays: state.settings.gtd?.autoArchiveDays,
                    focusTaskLimit: state.settings.gtd?.focusTaskLimit,
                    ...(isSave(request) && request.intent === 'referenceBackdate'
                        ? { pomodoro: { linkTask: state.settings.gtd?.pomodoro?.linkTask } } : {}) },
                ...(isSave(request) && request.intent === 'referenceBackdate'
                    ? { features: { pomodoro: state.settings.features?.pomodoro } } : {}),
                ...(isSave(request) && request.intent === 'cancel'
                    ? { undoNotificationsEnabled: state.settings.undoNotificationsEnabled } : {}) })) as AppData['settings'];
            const cancelTranslator = isSave(request) && request.intent === 'cancel' ? getTranslator(deps.language()) : null;
            const witness: Witness = {
                source, lists: { tasks: state._allTasks, projects: state._allProjects,
                    sections: state._allSections, areas: state._allAreas },
                settings, preparedAt, futureBoundary: boundary,
                preparedOffsetMinutes: new Date(preparedAt).getTimezoneOffset(),
                boundaryOffsetMinutes: new Date(boundary).getTimezoneOffset(),
                preparedLocalDay: new Date(Date.parse(preparedAt) - new Date(preparedAt).getTimezoneOffset() * 60_000)
                    .toISOString().slice(0, 10),
                deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                recurrenceProjection: isSave(request) && (!request.intent || request.intent === 'referenceComplete' || request.intent === 'referenceBackdate') && request.patch.status === 'done' && task.status !== 'done'
                    && task.status !== 'archived' ? projectNextRecurringTask(task,
                        request.intent === 'referenceBackdate' ? request.patch.completedAt! : preparedAt) : null,
                ...(isSave(request) && request.intent === 'skip'
                    ? { calendarTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } : {}),
                ids: [], directClears: cleared(direct), direct: JSON.parse(JSON.stringify(direct)),
                focusCount: countFocusedTasksBeforeBoundary(state.tasks, boundary),
                focusLimit: normalizeFocusTaskLimit(state.settings.gtd?.focusTaskLimit),
                ...(cancelTranslator ? { cancelMessage: resolveI18nText(cancelTranslator, 'task.cancelledWithRestore'),
                    cancelUndoLabel: resolveI18nText(cancelTranslator, 'common.undo') } : {}),
            };
            let first = plan(kind, request, witness, true, false, selection, boardCompletion);
            const noop = Boolean(selection && !first.effect.tasks.length && !first.effect.projects.length && !first.effect.sections.length);
            if (noop) {
                witness.deviceIdToInitialize = null;
                first = plan(kind, request, witness, false, false, selection, boardCompletion);
            }
            reduceWitness(witness, first.effect, state, isReferenceMenuRequest(request) || boardCompletion);
            const bounded = plan(kind, request, witness, false, false, selection, boardCompletion);
            if (!same(first, bounded)) return fail('INVALID_INPUT', 'Checklist effect exceeds the bounded witness');
            const frozen = detach(JSON.parse(JSON.stringify({ version: selection ? 2 : 1, kind: noop ? 'noop' : kind, request, witness,
                ...(!noop ? { effect: bounded.effect } : {}), result: bounded.result,
                ...(selection && durable ? { rawBefore: noop
                    ? rawReadTaskSnapshot(durable.data.tasks.find((row) => row.id === request.id)!)
                    : bindRawChecklistRows(bounded.effect, durable.data) } : {}) })), selection ? 16 * 1024 * 1024 : LIMIT_BYTES);
            const checked = frozen && readChecklistPrepared({ request, prepared: frozen }, deps.validateField, selection, boardCompletion);
            if (!checked) {
                return fail('INVALID_INPUT', 'Checklist effect cannot produce a valid prepared journal');
            }
            return { ok: true, value: noop ? { kind: 'noop', prepared: checked as NativeOwnedCompleteChecklistNoop }
                : { kind: 'prepared', prepared: checked as NativePreparedChecklistWrite } };
        } catch (error) {
            if (isReferenceOperation(request) && error instanceof Error && /^Focus limit of \d+ reached$/.test(error.message))
                return fail('INVALID_INPUT', error.message);
            return fail('INVALID_INPUT', 'Checklist could not be prepared');
        }
    };
    const prepare = (kind: 'save' | 'reset', input: unknown, retainInferredParent = false): NativeHostResult<NativeChecklistPreparation> =>
        prepareChecklist(kind, input, undefined, undefined, retainInferredParent) as NativeHostResult<NativeChecklistPreparation>;
    const commitEffect = async <T>(effect: PreparedChecklistEffect, result: T): Promise<NativeHostResult<T>> => {
        const applied = await useTaskStore.getState().commitPreparedChecklistEffect(effect);
        if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared task change conflicts with current data');
        try {
            if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
        } catch (error) {
            return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error));
        }
        const saved = await deps.save();
        return saved.ok ? { ok: true, value: result } : saved;
    };
    const commitReceipted = <T>(requestId: string, payload: string, effect: PreparedChecklistEffect, result: T): Promise<NativeHostResult<T>> =>
        deps.receipts.run(requestId, payload, async () => {
            const applied = await useTaskStore.getState().commitPreparedChecklistEffect(effect, { requireBefore: true });
            return applied.success ? { ok: true, value: result }
                : fail('STALE_REVISION', applied.error ?? 'Prepared task change conflicts with current data');
        });
    const prepareRawCompletion = async (input: NativeReferenceTaskCompletionRequest | NativeBoardTaskCompletionRequest): Promise<NativeHostResult<{ kind: 'prepared'; prepared: NativePreparedTaskCompletion & { version: 2 } }>> => {
        const board = input.source === 'board';
        const request = board ? readBoardCompletionRequest(input) : readReferenceCompletionRequest(input);
        if (!request) return fail('INVALID_INPUT', 'Completion source request is malformed');
        const ready = deps.readiness(); if (!ready.ok) return ready;
        const state = useTaskStore.getState();
        const matches = state._allTasks.filter(row => row.id === request.id);
        const task = matches.length === 1 ? matches[0] : null;
        const source = board ? !task ? fail('TASK_NOT_FOUND', 'Board task not found')
            : taskRevisionOf(task) !== request.taskRevision ? fail('STALE_REVISION', 'Board task changed since it was shown')
            : !canCompleteNativeBoardTask(task, state._allProjects, state._allSections, deps.isReadOnly(task))
                ? fail('INVALID_INPUT', 'Board task cannot be completed') : { ok: true as const, value: task }
            : readHistoryRowSource({ id: request.id, taskRevision: request.taskRevision }, false, true);
        if (!source.ok) return source;
        const read = await readAreaDurableData(false, true); if (!read.ok) return read;
        if (board && !sameBoardCompletionContainer(source.value, { projects: state._allProjects, sections: state._allSections }, read.value.authority.snapshot))
            return fail('STALE_REVISION', 'Board completion container changed before preparation');
        const planned = prepare('save', board ? completionSaveRequest(source.value, request.requestId)
            : referenceCompletionSaveRequest(source.value, request.requestId), board);
        if (!planned.ok) return planned;
        if (planned.value.kind !== 'prepared') return fail('INVALID_INPUT', 'Reference completion made no change');
        const checklist = planned.value.prepared;
        const t = getTranslator(deps.language()); const formatted = formatTaskMarkedDoneMessage(t, source.value.title);
        const done = resolveI18nText(t, 'common.done'); const undo = resolveI18nText(t, 'common.undo');
        const message = validCancelText(formatted, 512) ? formatted : validCancelText(done, 512) ? done : 'Done';
        const undoLabel = validCancelText(undo, 80) ? undo : 'Undo';
        const completedAt = checklist.effect.tasks.find((row) => row.after.id === request.id)?.after.completedAt;
        if (!completedAt) return fail('INVALID_INPUT', 'Reference completion has no instant');
        const prepared = detach({ version: 2 as const, kind: board ? 'boardComplete' as const : 'referenceComplete' as const, request,
            rawBefore: JSON.parse(JSON.stringify(bindRawChecklistRows(checklist.effect, read.value.authority.snapshot))), checklist,
            notice: { message, undoLabel }, result: { id: request.id, completion: { completedAt, undoEnabled: true, message, undoLabel } } }, COMPLETION_BYTES);
        const envelope = prepared && readCompletion({ request, prepared }, deps.validateField);
        return envelope?.prepared.version === 2 ? { ok: true, value: { kind: 'prepared', prepared: envelope.prepared } }
            : fail('INVALID_INPUT', 'Reference completion cannot produce a valid bounded journal');
    };
    function prepareCompletion(input: NativeReferenceTaskCompletionRequest | NativeBoardTaskCompletionRequest): Promise<NativeHostResult<{ kind: 'prepared'; prepared: NativePreparedTaskCompletion & { version: 2 } }>>;
    function prepareCompletion(input: NativeTaskCompletionRequest & { source?: never }): NativeHostResult<{ kind: 'prepared'; prepared: NativePreparedOrdinaryTaskCompletion }>;
    function prepareCompletion(input: NativeTaskCompletionRequest): NativeHostResult<{ kind: 'prepared'; prepared: NativePreparedTaskCompletion }> | Promise<NativeHostResult<{ kind: 'prepared'; prepared: NativePreparedTaskCompletion }>>;
    function prepareCompletion(input: NativeTaskCompletionRequest): NativeHostResult<{ kind: 'prepared'; prepared: NativePreparedTaskCompletion }> | Promise<NativeHostResult<{ kind: 'prepared'; prepared: NativePreparedTaskCompletion }>> {
        if (input?.source === 'reference' || input?.source === 'board') return prepareRawCompletion(input as NativeReferenceTaskCompletionRequest | NativeBoardTaskCompletionRequest);
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readCompletionRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A displayed task revision and request UUID are required');
            const state = useTaskStore.getState();
            const task = state._tasksById.get(request.id);
            if (!task || task.deletedAt || task.purgedAt) return fail('TASK_NOT_FOUND', 'Task not found');
            if (taskRevisionOf(task) !== request.taskRevision) return fail('STALE_REVISION', 'Task changed since it was shown');
            if (!canCompleteNativeTask(task, state._allProjects, deps.isReadOnly(task)))
                return fail('INVALID_INPUT', 'Task cannot be completed');
            const planned = prepare('save', completionSaveRequest(task, request.requestId));
            if (!planned.ok) return planned;
            if (planned.value.kind !== 'prepared') return fail('INVALID_INPUT', 'Task completion made no change');
            const translator = getTranslator(deps.language());
            const formatted = formatTaskMarkedDoneMessage(translator, task.title);
            const done = resolveI18nText(translator, 'common.done');
            const message = validCancelText(formatted, 512) ? formatted
                : validCancelText(done, 512) ? done : 'Done';
            const translatedUndo = resolveI18nText(translator, 'common.undo');
            const undoLabel = validCancelText(translatedUndo, 80) ? translatedUndo : 'Undo';
            const completed = planned.value.prepared.effect.tasks.find((row) => row.after.id === request.id)?.after;
            if (!completed?.completedAt)
                return fail('INVALID_INPUT', 'Completion notice cannot be represented');
            const result: NativeTaskCompletionResult = { id: request.id,
                completion: { completedAt: completed.completedAt, undoEnabled: true, message, undoLabel } };
            const prepared = detach({ version: 1 as const, kind: 'complete' as const, request,
                checklist: planned.value.prepared, notice: { message, undoLabel }, result }, COMPLETION_BYTES);
            return prepared && readCompletion({ request, prepared }, deps.validateField)
                ? { ok: true, value: { kind: 'prepared', prepared } }
                : fail('INVALID_INPUT', 'Completion cannot produce a valid bounded journal');

    }
    const prepareRawCompletionUndo = async (input: { request: NativeTaskCompletionUndoRequest; completion: NativeTaskCompletionEnvelope }): Promise<NativeHostResult<{ kind: 'prepared'; prepared: NativePreparedTaskCompletionUndo & { version: 2 } }>> => {
        const ready = deps.readiness(); if (!ready.ok) return ready;
        const request = readCompletionUndoRequest(input?.request); const completion = readCompletion(input?.completion, deps.validateField);
        const board = completion?.prepared.kind === 'boardComplete';
        if (!request || !completion || (!board && completion.prepared.kind !== 'referenceComplete') || request.completionRequestId !== completion.request.requestId)
            return fail('INVALID_INPUT', 'A confirmed Reference completion and new Undo UUID are required');
        const confirmed = historyRowReceipts.saved<NativeTaskCompletionResult>(completion.request.requestId, canonicalJSON([completion.prepared.kind === 'boardComplete' ? 'boardTaskCompletion' : 'referenceTaskCompletion', completion]));
        if (!confirmed?.ok || !same(confirmed.value, completion.prepared.result)) return fail('STALE_REVISION', 'Completion has no saved request receipt');
        const read = await readAreaDurableData(false, true); if (!read.ok) return read;
        const state = useTaskStore.getState(); const task = state._tasksById.get(completion.request.id);
        if (board && (!task || !sameBoardCompletionContainer(task, { projects: state._allProjects, sections: state._allSections }, read.value.authority.snapshot)
            || !sameBoardCompletionContainer(completion.prepared.checklist.witness.source, { projects: state._allProjects, sections: state._allSections }, read.value.authority.snapshot)))
            return fail('STALE_REVISION', 'Board Undo container changed before preparation');
        const completed = completion.prepared.checklist.effect.tasks.find((row) => row.after.id === completion.request.id)?.after;
        if (!task || !completed || task.deletedAt || task.purgedAt || task.status !== 'done' || task.completedAt !== completed.completedAt
            || (task.rev ?? 0) < (completed.rev ?? 0) || deps.isReadOnly(task)
            || (board ? !boardUndoContainerMatches(completion, task, { projects: state._allProjects, sections: state._allSections })
                : referenceContainerReadOnly(task, { projects: state._allProjects, sections: state._allSections })))
            return fail('STALE_REVISION', 'Reference completion was superseded');
        try {
            const at = new Date().toISOString(); const boundary = futureBoundary(at); const device = ensureDeviceId(state.settings);
            const witness: Witness = { source: JSON.parse(JSON.stringify(task)), lists: { tasks: state._allTasks,
                projects: state._allProjects, sections: state._allSections, areas: state._allAreas },
                settings: JSON.parse(JSON.stringify({ deviceId: state.settings.deviceId, gtd: { focusTaskLimit: state.settings.gtd?.focusTaskLimit,
                    ...(board ? { autoArchiveDays: state.settings.gtd?.autoArchiveDays } : {}) } })),
                preparedAt: at, preparedLocalDay: new Date(Date.parse(at) - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 10),
                preparedOffsetMinutes: new Date(at).getTimezoneOffset(), boundaryOffsetMinutes: new Date(boundary).getTimezoneOffset(), futureBoundary: boundary,
                deviceIdBefore: state.settings.deviceId ?? null, deviceIdToInitialize: device.updated ? device.deviceId : null,
                recurrenceProjection: null, ids: [], directClears: [], direct: { status: 'reference' },
                focusCount: countFocusedTasksBeforeBoundary(state.tasks, boundary), focusLimit: normalizeFocusTaskLimit(state.settings.gtd?.focusTaskLimit) };
            if (board) {
                const direct = completionUndoDirect(completion, witness);
                witness.directClears = cleared(direct); witness.direct = JSON.parse(JSON.stringify(direct));
            }
            const first = planRawCompletionUndo(completion, witness);
            reduceWitness(witness, first, state, true, board ? completion.prepared.checklist.witness.source : undefined);
            const effect = planRawCompletionUndo(completion, witness);
            if (!same(first, effect)) return fail('INVALID_INPUT', 'Reference Undo exceeds bounded witness');
            const prepared = detach(JSON.parse(JSON.stringify({ version: 2 as const, kind: board ? 'boardCompleteUndo' as const : 'referenceCompleteUndo' as const, request, completion,
                rawBefore: JSON.parse(JSON.stringify(bindRawChecklistRows(effect, read.value.authority.snapshot))), witness, effect, result: { id: task.id } })), COMPLETION_UNDO_BYTES);
            const envelope = prepared && readCompletionUndo({ request, prepared }, deps.validateField);
            return envelope?.prepared.version === 2 ? { ok: true, value: { kind: 'prepared', prepared: envelope.prepared } }
                : fail('INVALID_INPUT', 'Reference Undo cannot produce a valid bounded journal');
        } catch { return fail('STALE_REVISION', 'Reference recurring follow-up or destination changed'); }
    };
    function prepareCompletionUndo(input: { request: NativeTaskCompletionUndoRequest; completion: NativeTaskCompletionEnvelope & { prepared: NativePreparedOrdinaryTaskCompletion } }): NativeHostResult<{ kind: 'prepared'; prepared: NativePreparedOrdinaryTaskCompletionUndo }>;
    function prepareCompletionUndo(input: { request: NativeTaskCompletionUndoRequest; completion: NativeTaskCompletionEnvelope }): NativeHostResult<{ kind: 'prepared'; prepared: NativePreparedTaskCompletionUndo }> | Promise<NativeHostResult<{ kind: 'prepared'; prepared: NativePreparedTaskCompletionUndo }>>;
    function prepareCompletionUndo(input: { request: NativeTaskCompletionUndoRequest; completion: NativeTaskCompletionEnvelope }): NativeHostResult<{ kind: 'prepared'; prepared: NativePreparedTaskCompletionUndo }> | Promise<NativeHostResult<{ kind: 'prepared'; prepared: NativePreparedTaskCompletionUndo }>> {
        if (input?.completion?.prepared?.kind === 'referenceComplete' || input?.completion?.prepared?.kind === 'boardComplete') return prepareRawCompletionUndo(input);

            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readCompletionUndoRequest(input?.request);
            const completion = readCompletion(input?.completion, deps.validateField);
            if (!request || !completion || request.completionRequestId !== completion.request.requestId)
                return fail('INVALID_INPUT', 'A confirmed completion and new Undo UUID are required');
            const confirmed = deps.receipts.saved<NativeTaskCompletionResult>(completion.request.requestId,
                canonicalJSON(['taskCompletion', completion]));
            if (!confirmed?.ok || !same(confirmed.value, completion.prepared.result))
                return fail('STALE_REVISION', 'Completion has no saved request receipt');
            const state = useTaskStore.getState();
            const matches = state._allTasks.filter((row) => row.id === completion.request.id);
            const task = matches.length === 1 ? matches[0] : null;
            const completed = completion.prepared.checklist.effect.tasks.find((row) => row.after.id === completion.request.id)?.after;
            const child = ownedCompletionChild(completion);
            if (!task || !completed || task.deletedAt || task.purgedAt || task.status !== 'done'
                || task.completedAt !== completed.completedAt || (task.rev ?? 0) < (completed.rev ?? 0)
                || deps.isReadOnly(task) || isStatusListTaskReadOnly(task, state._allProjects)
                || (child && !sameSavedTask(state._allTasks.find((row) => row.id === child.id), child)))
                return fail('STALE_REVISION', 'Completion or its recurring follow-up was superseded');
            try {
                const preparedAt = new Date().toISOString();
                const boundary = futureBoundary(preparedAt);
                const device = ensureDeviceId(state.settings);
                const witness: Witness = {
                    source: JSON.parse(JSON.stringify(task)) as Task,
                    lists: { tasks: state._allTasks, projects: state._allProjects,
                        sections: state._allSections, areas: state._allAreas },
                    settings: JSON.parse(JSON.stringify({ deviceId: state.settings.deviceId,
                        gtd: { autoArchiveDays: state.settings.gtd?.autoArchiveDays,
                            focusTaskLimit: state.settings.gtd?.focusTaskLimit } })) as AppData['settings'],
                    preparedAt, futureBoundary: boundary,
                    preparedOffsetMinutes: new Date(preparedAt).getTimezoneOffset(),
                    boundaryOffsetMinutes: new Date(boundary).getTimezoneOffset(),
                    preparedLocalDay: new Date(Date.parse(preparedAt) - new Date(preparedAt).getTimezoneOffset() * 60_000)
                        .toISOString().slice(0, 10),
                    deviceIdBefore: state.settings.deviceId ?? null,
                    deviceIdToInitialize: device.updated ? device.deviceId : null,
                    recurrenceProjection: null, ids: [], directClears: [], direct: {},
                    focusCount: countFocusedTasksBeforeBoundary(state.tasks, boundary),
                    focusLimit: normalizeFocusTaskLimit(state.settings.gtd?.focusTaskLimit),
                };
                const direct = completionUndoDirect(completion, witness);
                witness.directClears = cleared(direct);
                witness.direct = JSON.parse(JSON.stringify(direct));
                const first = planCompletionUndo(completion, witness);
                reduceWitness(witness, first, state);
                const bounded = planCompletionUndo(completion, witness);
                if (!same(first, bounded)) return fail('INVALID_INPUT', 'Undo effect exceeds the bounded witness');
                const prepared = detach(JSON.parse(JSON.stringify({ version: 1 as const, kind: 'undo' as const, request, completion,
                    witness, effect: bounded, result: { id: task.id } })), COMPLETION_UNDO_BYTES) as NativePreparedTaskCompletionUndo | null;
                return prepared && readCompletionUndo({ request, prepared }, deps.validateField)
                    ? { ok: true, value: { kind: 'prepared', prepared } }
                    : fail('INVALID_INPUT', 'Undo cannot produce a valid bounded journal');
            } catch { return fail('INVALID_INPUT', 'Undo could not be prepared'); }

    }
    const prepareCancellationUndo = (input: { request: NativeTaskCancellationUndoRequest; cancel: NativeChecklistCancellationEnvelope | NativeOwnedCompleteChecklistCancellation },
        owned?: { cancel: NativeOwnedCompleteChecklistCancellation; identity: unknown; data: AppData; at: string }): NativeHostResult<
            { kind: 'prepared'; prepared: NativePreparedTaskCancellationUndo | NativePreparedOwnedCompleteCancellationUndo }> => {
        const ready = deps.readiness();
        if (!ready.ok) return ready;
        const request = readUndoRequest(input?.request);
        const cancel = owned?.cancel ?? readCancellation(input?.cancel, deps.validateField);
        if (!request || !cancel || request.cancelRequestId !== cancel.request.requestId)
            return fail('INVALID_INPUT', 'A confirmed cancellation and new Undo UUID are required');
        const state = owned ? ownedChecklistState(owned.data, owned.at) : useTaskStore.getState();
        const matches = state._allTasks.filter((row) => row.id === cancel.request.id);
        const task = matches.length === 1 ? matches[0] : null;
        const cancelled = cancel.prepared.effect.tasks.find((row) => row.after.id === cancel.request.id)?.after;
        if (!task || !cancelled || task.deletedAt || task.purgedAt || task.status !== 'archived'
            || task.cancelledAt !== cancelled.cancelledAt
            || isStatusListTaskReadOnly(task, state._allProjects) || deps.isReadOnly(task))
            return fail('STALE_REVISION', 'Cancellation was superseded');
        try {
            const preparedAt = owned?.at ?? new Date().toISOString();
            const boundary = futureBoundary(preparedAt);
            const device = ensureDeviceId(state.settings);
            const direct = taskCancellationRestoreFields(cancel.prepared.witness.source);
            const witness: Witness = {
                source: JSON.parse(JSON.stringify(task)) as Task,
                lists: { tasks: state._allTasks, projects: state._allProjects,
                    sections: state._allSections, areas: state._allAreas },
                settings: JSON.parse(JSON.stringify({ deviceId: state.settings.deviceId,
                    gtd: { autoArchiveDays: state.settings.gtd?.autoArchiveDays,
                        focusTaskLimit: state.settings.gtd?.focusTaskLimit } })) as AppData['settings'],
                preparedAt, futureBoundary: boundary,
                preparedOffsetMinutes: new Date(preparedAt).getTimezoneOffset(),
                boundaryOffsetMinutes: new Date(boundary).getTimezoneOffset(),
                preparedLocalDay: new Date(Date.parse(preparedAt) - new Date(preparedAt).getTimezoneOffset() * 60_000)
                    .toISOString().slice(0, 10),
                deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                recurrenceProjection: null, ids: [], directClears: cleared(direct),
                direct: JSON.parse(JSON.stringify(direct)),
                focusCount: countFocusedTasksBeforeBoundary(state.tasks, boundary),
                focusLimit: normalizeFocusTaskLimit(state.settings.gtd?.focusTaskLimit),
            };
            const first = plan('save', cancel.request, witness, true, true, owned ? ownedChecklistSelection : undefined);
            if (witness.ids.length !== 0) return fail('INVALID_INPUT', 'Undo cannot create recurring tasks');
            reduceWitness(witness, first.effect, state);
            const bounded = plan('save', cancel.request, witness, false, true, owned ? ownedChecklistSelection : undefined);
            if (!same(first, bounded)) return fail('INVALID_INPUT', 'Undo effect exceeds the bounded witness');
            const prepared = detach(JSON.parse(JSON.stringify({ version: owned ? 2 : 1, kind: 'undo' as const, request, cancel: owned ? owned.identity : cancel, witness,
                effect: bounded.effect, result: bounded.result, ...(owned ? { rawBefore: bindRawChecklistRows(bounded.effect, owned.data) } : {}) })), owned ? 24 * 1024 * 1024 : LIMIT_BYTES);
            if (!prepared) return fail('INVALID_INPUT', 'Undo cannot produce a valid bounded journal');
            const checked = readCancellationUndoProof({ request, prepared }, deps.validateField, owned);
            return checked
                ? { ok: true, value: { kind: 'prepared', prepared: checked.prepared } }
                : fail('INVALID_INPUT', 'Undo cannot produce a valid bounded journal');
        } catch { return fail('INVALID_INPUT', 'Undo could not be prepared'); }
    };
    const ownedSaves = createAreaSaveGuard(deps.save);
    const readOwnedDecision = (input: unknown): NativeOwnedCompleteChecklistDecision | null => {
        const value = detach(input, 16 * 1024 * 1024);
        if (!isRecord(value) || !exact(value, ['kind', 'prepared']) || !isRecord(value.prepared)) return null;
        const checked = readChecklistPrepared({ request: value.prepared.request, prepared: value.prepared }, deps.validateField, ownedChecklistSelection);
        return checked && checked.version === 2 && (value.kind === 'noop' ? checked.kind === 'noop' : value.kind === 'changed' && checked.kind === 'save')
            ? value as unknown as NativeOwnedCompleteChecklistDecision : null;
    };
    const readOwnedCancellation = (input: NativeOwnedCompleteChecklistCancellation): NativeOwnedCompleteChecklistCancellation | null => {
        const decision = readOwnedDecision({ kind: 'changed', prepared: input?.prepared });
        return decision?.kind === 'changed' && decision.prepared.request.intent === 'cancel'
            && same(input.request, decision.prepared.request) && 'cancellation' in decision.prepared.result
            ? { request: decision.prepared.request as NativeOwnedCompleteChecklistCancellation['request'], prepared: decision.prepared } : null;
    };
    const readOwnedUndo = (input: unknown, cancel: NativeOwnedCompleteChecklistCancellation, identity: unknown): NativeOwnedCompleteCancellationUndoEnvelope | null => {
        const checked = readOwnedCancellation(cancel);
        return checked ? readCancellationUndoProof(input, deps.validateField, { cancel: checked, identity }) as NativeOwnedCompleteCancellationUndoEnvelope | null : null;
    };
    const currentOwnedWitness = (witness: Witness, data: AppData): Witness => {
        const state = ownedChecklistState(data, witness.preparedAt), source = state._tasksById.get(witness.source.id);
        if (!source || !same(source, witness.source) || source.deletedAt || source.purgedAt || deps.isReadOnly(source)
            || isStatusListTaskReadOnly(source, state._allProjects)) throw new Error('Owned source or container changed');
        return { ...witness, source, lists: { tasks: state._allTasks, projects: state._allProjects,
            sections: state._allSections, areas: state._allAreas }, settings: data.settings,
            deviceIdBefore: data.settings.deviceId ?? null,
            focusCount: countFocusedTasksBeforeBoundary(state.tasks, witness.futureBoundary),
            focusLimit: normalizeFocusTaskLimit(data.settings.gtd?.focusTaskLimit) };
    };
    const commitOwnedEffect = async (proof: { witness: Witness; effect: PreparedChecklistEffect; rawBefore: PreparedChecklistRawBefore },
        request: NativeOwnedCompleteChecklistSaveRequest, identity: unknown, undo = false): Promise<NativeHostResult<null>> => {
        const ready = deps.readiness(); if (!ready.ok) return ready;
        const read = await readAreaDurableData(true, true); if (!read.ok) return read;
        const afterReady = deps.readiness(); if (!afterReady.ok) return afterReady;
        if (!ownedSaves.mayApply(identity, read.value.adapter)) return fail('SAVE_FAILED', 'Owned Save has an unrelated persistence failure');
        const data = read.value.authority.snapshot;
        if (ownedChecklistAfterMatches(data, proof.effect)) return ownedSaves.finish(identity, read.value.adapter, true, undefined);
        try {
            if (!ownedRawBeforeMatches(data, proof.rawBefore) || (data.settings.deviceId ?? null) !== proof.effect.deviceIdBefore
                || !same(plan('save', request, currentOwnedWitness(proof.witness, data), false, undo, ownedChecklistSelection).effect, proof.effect))
                return fail('STALE_REVISION', 'Owned affected rows or guards changed');
        } catch { return fail('STALE_REVISION', 'Owned source or destination changed'); }
        const applied = await useTaskStore.getState().commitPreparedChecklistEffect(proof.effect,
            { requireBefore: true, authority: read.value.authority, rawBefore: proof.rawBefore });
        if (!applied.success || applied.outcome !== 'applied') return fail('STALE_REVISION', applied.error ?? 'Owned Save was superseded');
        return ownedSaves.finish(identity, read.value.adapter, false, read.value.authority.saveBoundary);
    };
    const ownedAuthority = {
        readRequest(input: unknown): NativeOwnedCompleteChecklistSaveRequest | null {
            const request = ownedChecklistSelection.readRequest(input, deps.validateField);
            return request && isSave(request) ? request as NativeOwnedCompleteChecklistSaveRequest : null;
        },
        readDecision: readOwnedDecision,
        readUndo: readOwnedUndo,
        async prepareDecision(input: NativeOwnedCompleteChecklistSaveRequest): Promise<NativeHostResult<NativeOwnedCompleteChecklistDecision>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const request = ownedChecklistSelection.readRequest(input, deps.validateField);
            if (!request || !isSave(request)) return fail('INVALID_INPUT', 'A complete owned checklist request is required');
            const read = await readAreaDurableData(false, true); if (!read.ok) return read;
            const afterReady = deps.readiness(); if (!afterReady.ok) return afterReady;
            if (read.value.authority.snapshot.tasks.filter((row) => row.id === request.id).length !== 1)
                return fail('TASK_NOT_FOUND', 'Owned task is missing or duplicated');
            try {
                const prepared = prepareChecklist('save', request, ownedChecklistSelection,
                    { data: read.value.authority.snapshot, at: new Date().toISOString() });
                if (!prepared.ok) return prepared;
                if (prepared.value.kind === 'unchanged') return fail('INVALID_INPUT', 'An unbound unchanged result is not an owned proof');
                const decision = readOwnedDecision({ kind: prepared.value.kind === 'noop' ? 'noop' : 'changed', prepared: prepared.value.prepared });
                return decision ? { ok: true, value: decision } : fail('INVALID_INPUT', 'Owned Save cannot produce a bounded proof');
            } catch { return fail('INVALID_INPUT', 'Owned saved rows cannot be prepared'); }
        },
        async commitDecision(input: NativeOwnedCompleteChecklistDecision, identity: unknown): Promise<NativeHostResult<NativeChecklistResult>> {
            const decision = readOwnedDecision(input);
            if (!decision) return fail('INVALID_INPUT', 'An exact complete owned proof is required');
            if (decision.kind === 'changed') {
                const saved = await commitOwnedEffect(decision.prepared, decision.prepared.request, identity);
                return saved.ok ? { ok: true, value: decision.prepared.result } : saved;
            }
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const generation = getPersistenceStatus().generation;
            const read = await readAreaDurableData(false, true); if (!read.ok) return read;
            const afterReady = deps.readiness(); if (!afterReady.ok) return afterReady;
            const status = getPersistenceStatus(), proof = decision.prepared;
            if (status.generation !== generation || status.queued || status.inFlight || status.immediate || status.retrying || status.failed
                || useTaskStore.getState().persistenceFailure) return fail('SAVE_FAILED', 'Owned no-op has pending persistence');
            const matches = read.value.authority.snapshot.tasks.filter((row) => row.id === proof.request.id);
            try {
                if (matches.length !== 1 || !sameOwnedRawTask(matches[0], proof.rawBefore)
                    || (read.value.authority.snapshot.settings.deviceId ?? null) !== proof.witness.deviceIdBefore
                    || !same(plan('save', proof.request, proof.witness, false, false, ownedChecklistSelection),
                        plan('save', proof.request, currentOwnedWitness(proof.witness, read.value.authority.snapshot), false, false, ownedChecklistSelection)))
                    return fail('STALE_REVISION', 'Owned no-op source or eligibility changed');
            } catch { return fail('STALE_REVISION', 'Owned no-op source or destination changed'); }
            return { ok: true, value: proof.result };
        },
        async prepareUndo(request: NativeTaskCancellationUndoRequest, cancel: NativeOwnedCompleteChecklistCancellation,
            identity: unknown): Promise<NativeHostResult<{ kind: 'prepared'; prepared: NativePreparedOwnedCompleteCancellationUndo }>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const checked = readOwnedCancellation(cancel), parsed = readUndoRequest(request);
            if (!checked || !parsed || parsed.requestId.length !== 36 || parsed.cancelRequestId.length !== 36)
                return fail('INVALID_INPUT', 'An exact owned cancellation and Undo UUID are required');
            const read = await readAreaDurableData(false, true); if (!read.ok) return read;
            const afterReady = deps.readiness(); if (!afterReady.ok) return afterReady;
            if (read.value.authority.snapshot.tasks.filter((row) => row.id === checked.request.id).length !== 1)
                return fail('TASK_NOT_FOUND', 'Owned cancelled task is missing or duplicated');
            try {
                const prepared = prepareCancellationUndo({ request: parsed, cancel: checked },
                    { cancel: checked, identity, data: read.value.authority.snapshot, at: new Date().toISOString() });
                return prepared as NativeHostResult<{ kind: 'prepared'; prepared: NativePreparedOwnedCompleteCancellationUndo }>;
            } catch { return fail('INVALID_INPUT', 'Owned cancellation Undo cannot be prepared'); }
        },
        async commitUndo(input: NativeOwnedCompleteCancellationUndoEnvelope, cancel: NativeOwnedCompleteChecklistCancellation,
            cancelIdentity: unknown, identity: unknown): Promise<NativeHostResult<{ id: string }>> {
            const checked = readOwnedUndo(input, cancel, cancelIdentity);
            if (!checked) return fail('INVALID_INPUT', 'An exact owned cancellation Undo proof is required');
            const saved = await commitOwnedEffect(checked.prepared, cancel.request, identity, true);
            return saved.ok ? { ok: true, value: checked.prepared.result } : saved;
        },
    };
    const publicMethods = {
        getReferenceTaskDestinationOptions(input: NativeReferenceTaskDestinationOptionsInput): NativeHostResult<NativeReferenceTaskDestinationOptions> {
            const parsed = detach(input);
            if (!isRecord(parsed) || !exact(parsed, ['id', 'taskRevision', 'query', 'offset', 'limit'])
                || typeof parsed.query !== 'string' || parsed.query.length > 2000
                || !Number.isSafeInteger(parsed.offset) || (parsed.offset as number) < 0
                || !Number.isSafeInteger(parsed.limit) || (parsed.limit as number) < 1 || (parsed.limit as number) > 100)
                return fail('INVALID_INPUT', 'A displayed Reference row and bounded destination page are required');
            const source = readHistoryRowSource({ id: parsed.id, taskRevision: parsed.taskRevision }, false, true);
            if (!source.ok) return source;
            const state = useTaskStore.getState();
            if (referenceContainerReadOnly(source.value, { projects: state._allProjects, sections: state._allSections }))
                return fail('INVALID_INPUT', 'Reference task is read-only');
            const t = getTranslator(deps.language());
            const query = input.query.trim().toLowerCase();
            const choices: NativeReferenceTaskDestinationOptions['choices'] = [
                { kind: 'none', id: '', label: resolveI18nText(t, 'common.none'), selected: !source.value.projectId && !source.value.areaId },
                ...getProjectChoiceState(state.projects, input.query).filteredProjects.map((row) => ({
                    kind: 'project' as const, id: row.id, label: row.title, selected: source.value.projectId === row.id })),
                ...state.areas.filter((row) => !row.deletedAt).sort(compareAreasByOrder)
                    .filter((row) => !query || row.name.toLowerCase().includes(query)).map((row) => ({
                        kind: 'area' as const, id: row.id, label: row.name, selected: source.value.areaId === row.id })),
            ];
            const page = choices.slice(input.offset, input.offset + input.limit);
            const hasMore = input.offset + page.length < choices.length;
            return { ok: true, value: { version: 1, ...input, total: choices.length, hasMore,
                nextOffset: hasMore ? input.offset + page.length : null, choices: page,
                labels: { title: resolveI18nText(t, 'task.destination'), search: resolveI18nText(t, 'common.search'),
                    projects: resolveI18nText(t, 'nav.projects'), areas: resolveI18nText(t, 'taskEdit.areaLabel'),
                    cancel: resolveI18nText(t, 'common.cancel'), more: resolveI18nText(t, 'common.more'),
                    retry: resolveI18nText(t, 'common.retry'), noMatches: resolveI18nText(t, 'common.noMatches') } } };
        },
        async prepareReferenceTaskDestination(input: NativeReferenceTaskDestinationRequest): Promise<NativeHostResult<{
            kind: 'prepared'; prepared: NativePreparedReferenceTaskDestination;
        }>> {
            const request = readReferenceDestinationRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A displayed Reference revision and existing destination are required');
            const source = readHistoryRowSource({ id: request.id, taskRevision: request.taskRevision }, false, true);
            if (!source.ok) return source;
            const state = useTaskStore.getState();
            if (referenceContainerReadOnly(source.value, { projects: state._allProjects, sections: state._allSections }))
                return fail('INVALID_INPUT', 'Reference task is read-only');
            if (!referenceDestinationAvailable(request.destination, { projects: state.projects, areas: state.areas }))
                return fail('INVALID_INPUT', 'Reference destination is not available');
            const read = await readAreaDurableData(false, true); if (!read.ok) return read;
            if (!referenceDestinationAvailable(request.destination, { projects: read.value.authority.snapshot.projects, areas: read.value.authority.snapshot.areas ?? [] }))
                return fail('STALE_REVISION', 'Saved Reference destination is not available');
            const planned = prepare('save', referenceDestinationSaveRequest(source.value, request)); if (!planned.ok) return planned;
            if (planned.value.kind !== 'prepared') return fail('INVALID_INPUT', 'Reference filing did not produce a write');
            const checklist = planned.value.prepared;
            const prepared = detach({ version: 2 as const, kind: 'referenceDestination' as const, request,
                rawBefore: JSON.parse(JSON.stringify(bindRawChecklistRows(checklist.effect, read.value.authority.snapshot))),
                checklist, result: { id: request.id } }, COMPLETION_BYTES);
            const envelope = prepared && readReferenceDestination({ request, prepared }, deps.validateField);
            return envelope ? { ok: true, value: { kind: 'prepared', prepared: envelope.prepared } }
                : fail('INVALID_INPUT', 'Reference filing cannot produce a valid bounded journal');
        },
        validatePreparedReferenceTaskDestination(input: NativeReferenceTaskDestinationEnvelope): NativeHostResult<{ id: string }> {
            const envelope = readReferenceDestination(input, deps.validateField);
            return envelope ? { ok: true, value: envelope.prepared.result } : fail('INVALID_INPUT', 'Prepared Reference filing is malformed');
        },
        async commitPreparedReferenceTaskDestination(input: NativeReferenceTaskDestinationEnvelope): Promise<NativeHostResult<{ id: string }>> {
            const envelope = readReferenceDestination(input, deps.validateField);
            return envelope ? commitHistoryRowWrite(envelope) : fail('INVALID_INPUT', 'Prepared Reference filing is malformed');
        },
        referenceTaskDestinationOutcome(input: NativeReferenceTaskDestinationEnvelope): NativeHostResult<{ id: string } | null> {
            const envelope = readReferenceDestination(input, deps.validateField);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared Reference filing is malformed');
            const saved = historyRowReceipts.saved<{ id: string }>(envelope.request.requestId, canonicalJSON(['referenceTaskDestination', envelope]));
            return saved?.ok && !same(saved.value, envelope.prepared.result)
                ? fail('INVALID_INPUT', 'Saved Reference filing result does not match its journal') : saved ?? { ok: true, value: null };
        },
        getReferenceTaskBackdateOptions(input: { id: string; taskRevision: string }): NativeHostResult<{
            title: string; saveLabel: string; cancelLabel: string; taskId: string; taskRevision: string;
            initialValue: null; initialEpochMilliseconds: null; showTimeSpent: boolean;
            initialTimeSpentMinutes: number | null; timeSpentLabel: string; timeSpentPlaceholder: string;
        }> {
            const source = readHistoryRowSource(input, false, true); if (!source.ok) return source;
            const state = useTaskStore.getState();
            if (referenceContainerReadOnly(source.value, { projects: state._allProjects, sections: state._allSections }))
                return fail('INVALID_INPUT', 'Reference task is read-only');
            const t = getTranslator(deps.language());
            return { ok: true, value: { title: resolveI18nText(t, 'task.completedAtPromptTitle'),
                saveLabel: resolveI18nText(t, 'common.save'), cancelLabel: resolveI18nText(t, 'common.cancel'),
                taskId: source.value.id, taskRevision: input.taskRevision,
                // RN's row complete picker has no initialValue, including when
                // a Reference task carries an unrelated old completion stamp.
                initialValue: null, initialEpochMilliseconds: null,
                showTimeSpent: isTaskEditorTimeSpentEnabled(state.settings),
                initialTimeSpentMinutes: normalizeTimeSpentMinutes(source.value.timeSpentMinutes) ?? null,
                timeSpentLabel: resolveI18nText(t, 'taskEdit.timeSpentLabel'),
                timeSpentPlaceholder: resolveI18nText(t, 'taskEdit.timeSpentPlaceholder') } };
        },
        async prepareReferenceTaskBackdate(input: NativeReferenceTaskBackdateRequest): Promise<NativeHostResult<{
            kind: 'prepared'; prepared: NativePreparedReferenceTaskBackdate;
        }>> {
            const request = readReferenceBackdateRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A displayed Reference revision, canonical completion time and bounded minutes input are required');
            const source = readHistoryRowSource({ id: request.id, taskRevision: request.taskRevision }, false, true);
            if (!source.ok) return source;
            const state = useTaskStore.getState();
            if (referenceContainerReadOnly(source.value, { projects: state._allProjects, sections: state._allSections }))
                return fail('INVALID_INPUT', 'Reference task is read-only');
            if (isTaskEditorTimeSpentEnabled(state.settings) !== (request.timeSpentText !== null))
                return fail('INVALID_INPUT', 'Time-spent setting changed; reopen Completion time');
            const read = await readAreaDurableData(false, true); if (!read.ok) return read;
            if (isTaskEditorTimeSpentEnabled(read.value.authority.snapshot.settings) !== (request.timeSpentText !== null))
                return fail('STALE_REVISION', 'Saved time-spent setting changed; reopen Completion time');
            const planned = prepare('save', referenceBackdateSaveRequest(source.value, request)); if (!planned.ok) return planned;
            if (planned.value.kind !== 'prepared') return fail('INVALID_INPUT', 'Reference completion made no change');
            const checklist = planned.value.prepared;
            const prepared = detach({ version: 2 as const, kind: 'referenceBackdate' as const, request,
                rawBefore: JSON.parse(JSON.stringify(bindRawChecklistRows(checklist.effect, read.value.authority.snapshot))),
                checklist, result: { id: request.id } }, COMPLETION_BYTES);
            const envelope = prepared && readReferenceBackdate({ request, prepared }, deps.validateField);
            return envelope ? { ok: true, value: { kind: 'prepared', prepared: envelope.prepared } }
                : fail('INVALID_INPUT', 'Reference completion cannot produce a valid bounded journal');
        },
        validatePreparedReferenceTaskBackdate(input: NativeReferenceTaskBackdateEnvelope): NativeHostResult<{ id: string }> {
            const envelope = readReferenceBackdate(input, deps.validateField);
            return envelope ? { ok: true, value: envelope.prepared.result } : fail('INVALID_INPUT', 'Prepared Reference completion is malformed');
        },
        async commitPreparedReferenceTaskBackdate(input: NativeReferenceTaskBackdateEnvelope): Promise<NativeHostResult<{ id: string }>> {
            const envelope = readReferenceBackdate(input, deps.validateField);
            return envelope ? commitHistoryRowWrite(envelope) : fail('INVALID_INPUT', 'Prepared Reference completion is malformed');
        },
        referenceTaskBackdateOutcome(input: NativeReferenceTaskBackdateEnvelope): NativeHostResult<{ id: string } | null> {
            const envelope = readReferenceBackdate(input, deps.validateField);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared Reference completion is malformed');
            const saved = historyRowReceipts.saved<{ id: string }>(envelope.request.requestId,
                canonicalJSON(['referenceTaskBackdate', envelope]));
            return saved?.ok && !same(saved.value, envelope.prepared.result)
                ? fail('INVALID_INPUT', 'Saved Reference completion result does not match its journal') : saved ?? { ok: true, value: null };
        },
        getDoneTaskCompletedAtOptions(input: { id: string; taskRevision: string }): NativeHostResult<{
            title: string; saveLabel: string; cancelLabel: string; taskId: string; taskRevision: string;
            initialValue: string | null; initialEpochMilliseconds: number | null;
        }> {
            const source = readHistoryRowSource(input);
            if (!source.ok) return source;
            const t = getTranslator(deps.language());
            const initialValue = getTaskEditorBackdatedCompletionStart(source.value, createTaskDraft(source.value)).initialValue;
            return { ok: true, value: { title: resolveI18nText(t, 'task.completedAtPromptTitle'),
                saveLabel: resolveI18nText(t, 'common.save'), cancelLabel: resolveI18nText(t, 'common.cancel'),
                taskId: source.value.id, taskRevision: input.taskRevision,
                initialValue, initialEpochMilliseconds: initialValue === null ? null : new Date(initialValue).getTime() } };
        },
        async prepareDoneTaskCompletedAt(input: NativeDoneTaskCompletedAtRequest): Promise<NativeHostResult<{
            kind: 'prepared'; prepared: NativePreparedDoneTaskCompletedAt;
        }>> {
            const request = readDoneCompletedAtRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A displayed Done revision, canonical completion instant and request UUID are required');
            const source = readHistoryRowSource({ id: request.id, taskRevision: request.taskRevision });
            if (!source.ok) return source;
            const read = await readAreaDurableData(false, true);
            if (!read.ok) return read;
            const rawRows = read.value.authority.snapshot.tasks.filter((row) => row.id === request.id);
            const rawBefore = rawRows.length === 1 ? rawRows[0] : null;
            if (!rawBefore || rawBefore.status !== 'done' || rawBefore.deletedAt || rawBefore.purgedAt
                || taskRevisionOf(rawBefore) !== request.taskRevision
                || isStatusListTaskReadOnly(rawBefore, read.value.authority.snapshot.projects))
                return fail('STALE_REVISION', 'Saved Done task changed since the row was shown');
            const planned = prepare('save', completedAtSaveRequest(source.value, request, 'doneCompletedAt'));
            if (!planned.ok) return planned;
            if (planned.value.kind !== 'prepared') return fail('INVALID_INPUT', 'Completion time made no change');
            const prepared = detach({ version: 2 as const, kind: 'doneCompletedAt' as const, request,
                rawBefore: JSON.parse(JSON.stringify(rawBefore)) as Task,
                checklist: planned.value.prepared, result: { id: request.id } }, COMPLETION_BYTES);
            return prepared && readDoneCompletedAt({ request, prepared }, deps.validateField)
                ? { ok: true, value: { kind: 'prepared', prepared } }
                : fail('INVALID_INPUT', 'Completion time cannot produce a valid bounded journal');
        },
        validatePreparedDoneTaskCompletedAt(input: NativeDoneTaskCompletedAtEnvelope): NativeHostResult<{ id: string }> {
            const envelope = readDoneCompletedAt(input, deps.validateField);
            return envelope ? { ok: true, value: envelope.prepared.result }
                : fail('INVALID_INPUT', 'Prepared completion time is malformed');
        },
        async commitPreparedDoneTaskCompletedAt(input: NativeDoneTaskCompletedAtEnvelope): Promise<NativeHostResult<{ id: string }>> {
            const envelope = readDoneCompletedAt(input, deps.validateField);
            return envelope ? commitHistoryRowWrite(envelope) : fail('INVALID_INPUT', 'Prepared completion time is malformed');
        },
        doneTaskCompletedAtOutcome(input: NativeDoneTaskCompletedAtEnvelope): NativeHostResult<{ id: string } | null> {
            const envelope = readDoneCompletedAt(input, deps.validateField);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared completion time is malformed');
            const saved = historyRowReceipts.saved<{ id: string }>(envelope.request.requestId, canonicalJSON(['doneTaskCompletedAt', envelope]));
            return saved?.ok && !same(saved.value, envelope.prepared.result)
                ? fail('INVALID_INPUT', 'Saved completion time result does not match its journal')
                : saved ?? { ok: true, value: null };
        },
        getArchiveTaskCompletedAtOptions(input: { id: string; taskRevision: string }): NativeHostResult<{
            title: string; saveLabel: string; cancelLabel: string; taskId: string; taskRevision: string;
            initialValue: string | null; initialEpochMilliseconds: number | null;
        }> {
            const source = readHistoryRowSource(input, true);
            if (!source.ok) return source;
            const t = getTranslator(deps.language());
            const initialValue = getTaskEditorBackdatedCompletionStart(source.value, createTaskDraft(source.value)).initialValue;
            return { ok: true, value: { title: resolveI18nText(t, 'task.completedAtPromptTitle'),
                saveLabel: resolveI18nText(t, 'common.save'), cancelLabel: resolveI18nText(t, 'common.cancel'),
                taskId: source.value.id, taskRevision: input.taskRevision,
                initialValue, initialEpochMilliseconds: initialValue === null ? null : new Date(initialValue).getTime() } };
        },
        async prepareArchiveTaskCompletedAt(input: NativeArchiveTaskCompletedAtRequest): Promise<NativeHostResult<{
            kind: 'prepared'; prepared: NativePreparedArchiveTaskCompletedAt;
        }>> {
            const request = readDoneCompletedAtRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A displayed Done revision, canonical completion instant and request UUID are required');
            const source = readHistoryRowSource({ id: request.id, taskRevision: request.taskRevision }, true);
            if (!source.ok) return source;
            const read = await readAreaDurableData(false, true);
            if (!read.ok) return read;
            const rawRows = read.value.authority.snapshot.tasks.filter((row) => row.id === request.id);
            const rawBefore = rawRows.length === 1 ? rawRows[0] : null;
            if (!rawBefore || !isArchiveCompletedAtSource(rawBefore) || rawBefore.deletedAt || rawBefore.purgedAt
                || taskRevisionOf(rawBefore) !== request.taskRevision)
                return fail('STALE_REVISION', 'Saved Done task changed since the row was shown');
            const planned = prepare('save', completedAtSaveRequest(source.value, request, 'archiveCompletedAt'));
            if (!planned.ok) return planned;
            if (planned.value.kind !== 'prepared') return fail('INVALID_INPUT', 'Completion time made no change');
            const prepared = detach({ version: 2 as const, kind: 'archiveCompletedAt' as const, request,
                rawBefore: JSON.parse(JSON.stringify(rawBefore)) as Task,
                checklist: planned.value.prepared, result: { id: request.id } }, COMPLETION_BYTES);
            return prepared && readArchiveCompletedAt({ request, prepared }, deps.validateField)
                ? { ok: true, value: { kind: 'prepared', prepared } }
                : fail('INVALID_INPUT', 'Completion time cannot produce a valid bounded journal');
        },
        validatePreparedArchiveTaskCompletedAt(input: NativeArchiveTaskCompletedAtEnvelope): NativeHostResult<{ id: string }> {
            const envelope = readArchiveCompletedAt(input, deps.validateField);
            return envelope ? { ok: true, value: envelope.prepared.result }
                : fail('INVALID_INPUT', 'Prepared completion time is malformed');
        },
        async commitPreparedArchiveTaskCompletedAt(input: NativeArchiveTaskCompletedAtEnvelope): Promise<NativeHostResult<{ id: string }>> {
            const envelope = readArchiveCompletedAt(input, deps.validateField);
            return envelope ? commitHistoryRowWrite(envelope) : fail('INVALID_INPUT', 'Prepared completion time is malformed');
        },
        archiveTaskCompletedAtOutcome(input: NativeArchiveTaskCompletedAtEnvelope): NativeHostResult<{ id: string } | null> {
            const envelope = readArchiveCompletedAt(input, deps.validateField);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared completion time is malformed');
            const saved = historyRowReceipts.saved<{ id: string }>(envelope.request.requestId, canonicalJSON(['archiveTaskCompletedAt', envelope]));
            return saved?.ok && !same(saved.value, envelope.prepared.result)
                ? fail('INVALID_INPUT', 'Saved completion time result does not match its journal')
                : saved ?? { ok: true, value: null };
        },
        getDoneTaskStatusOptions(input: { id: string; taskRevision: string; source?: 'reference' }): NativeHostResult<{
            title: string; taskId: string; taskRevision: string; status: 'done' | 'reference';
            options: { status: NativeDoneTaskStatus; label: string; selected: boolean }[];
        }> {
            const reference = isRecord(input) && own(input, 'source');
            if (reference && (!exact(input, ['id', 'taskRevision', 'source']) || input.source !== 'reference')) return fail('INVALID_INPUT', 'Reference options are malformed');
            const source = readHistoryRowSource(reference ? { id: input.id, taskRevision: input.taskRevision } : input, false, reference);
            if (!source.ok) return source;
            const task = source.value;
            const state = useTaskStore.getState();
            if (reference && referenceContainerReadOnly(task, { projects: state._allProjects, sections: state._allSections })) return fail('INVALID_INPUT', 'Reference task is read-only');
            const t = getTranslator(deps.language());
            return { ok: true, value: { title: resolveI18nText(t, 'taskStatus.changeStatus'),
                taskId: task.id, taskRevision: input.taskRevision, status: reference ? 'reference' : 'done',
                options: DONE_STATUS_OPTIONS.map((status) => ({ status, label: resolveI18nText(t, `status.${status}`),
                    selected: status === (reference ? 'reference' : 'done') })) } };
        },
        async prepareDoneTaskStatus(input: NativeDoneTaskStatusRequest): Promise<NativeHostResult<
            { kind: 'noop'; result: { id: string } } | { kind: 'prepared'; prepared: NativePreparedDoneTaskStatus }>> {
            const request = readDoneStatusRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A displayed Done task revision, quick status and request UUID are required');
            const reference = request.source === 'reference';
            const menu = reference && request.status !== 'next';
            const action = reference ? 'Reference Next' : 'Done status';
            const source = readHistoryRowSource({ id: request.id, taskRevision: request.taskRevision }, false, reference);
            if (!source.ok) return source;
            if (menu && referenceContainerReadOnly(source.value, { projects: useTaskStore.getState()._allProjects, sections: useTaskStore.getState()._allSections })) return fail('INVALID_INPUT', 'Reference task is read-only');
            if (request.status === (reference ? 'reference' : 'done')) return { ok: true, value: { kind: 'noop', result: { id: request.id } } };
            const read = await readAreaDurableData(false, true);
            if (!read.ok) return read;
            const rawRows = read.value.authority.snapshot.tasks.filter((row) => row.id === request.id);
            const rawBefore = rawRows.length === 1 ? menu ? rawReadTaskSnapshot(rawRows[0]) : rawRows[0] : null;
            if (!rawBefore || rawBefore.status !== (reference ? 'reference' : 'done') || rawBefore.deletedAt || rawBefore.purgedAt
                || taskRevisionOf(rawBefore) !== request.taskRevision
                || isStatusListTaskReadOnly(rawBefore, read.value.authority.snapshot.projects)
                || reference && hasPurgedReferenceParent(rawBefore, read.value.authority.snapshot.projects))
                return fail('STALE_REVISION', `Saved ${reference ? 'Reference' : 'Done'} task changed since the row was shown`);
            const planned = prepare('save', doneStatusSaveRequest(source.value, request));
            if (!planned.ok) return planned;
            if (planned.value.kind !== 'prepared') return fail('INVALID_INPUT', `${action} made no change`);
            const prepared = detach({ version: 2 as const, kind: reference ? menu ? 'referenceStatus' as const : 'referenceNext' as const : 'doneStatus' as const, request,
                [menu ? 'rawBeforeTask' : 'rawBefore']: JSON.parse(JSON.stringify(rawBefore)) as Task,
                checklist: planned.value.prepared, result: { id: request.id } }, COMPLETION_BYTES);
            const envelope = prepared && readDoneStatus({ request, prepared }, deps.validateField);
            return envelope ? { ok: true, value: { kind: 'prepared', prepared: envelope.prepared } }
                : fail('INVALID_INPUT', `${action} cannot produce a valid bounded journal`);
        },
        validatePreparedDoneTaskStatus(input: NativeDoneTaskStatusEnvelope): NativeHostResult<{ id: string }> {
            const envelope = readDoneStatus(input, deps.validateField);
            return envelope ? { ok: true, value: envelope.prepared.result }
                : fail('INVALID_INPUT', 'Prepared Done status is malformed');
        },
        async commitPreparedDoneTaskStatus(input: NativeDoneTaskStatusEnvelope): Promise<NativeHostResult<{ id: string }>> {
            const envelope = readDoneStatus(input, deps.validateField);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared Done status is malformed');
            return commitHistoryRowWrite(envelope);
        },
        doneTaskStatusOutcome(input: NativeDoneTaskStatusEnvelope): NativeHostResult<{ id: string } | null> {
            const envelope = readDoneStatus(input, deps.validateField);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared Done status is malformed');
            const saved = historyRowReceipts.saved<{ id: string }>(envelope.request.requestId,
                canonicalJSON([rawWritePrefix(envelope), envelope]));
            return saved?.ok && !same(saved.value, envelope.prepared.result)
                ? fail('INVALID_INPUT', `Saved ${envelope.prepared.kind === 'referenceNext' ? 'Reference Next' : 'Done status'} result does not match its journal`)
                : saved ?? { ok: true, value: null };
        },
        prepareTaskCompletion: prepareCompletion,
        validatePreparedTaskCompletion(input: NativeTaskCompletionEnvelope): NativeHostResult<NativeTaskCompletionResult> {
            const envelope = readCompletion(input, deps.validateField);
            return envelope ? { ok: true, value: envelope.prepared.result }
                : fail('INVALID_INPUT', 'Prepared completion is malformed');
        },
        async commitPreparedTaskCompletion(input: NativeTaskCompletionEnvelope): Promise<NativeHostResult<NativeTaskCompletionResult>> {
            const envelope = readCompletion(input, deps.validateField);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared completion is malformed');
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (envelope.prepared.kind === 'referenceComplete' || envelope.prepared.kind === 'boardComplete') return commitHistoryRowWrite(envelope as NativeRawReferenceEnvelope & { prepared: { result: NativeTaskCompletionResult } });
            const result = await commitReceipted(envelope.request.requestId,
                canonicalJSON(['taskCompletion', envelope]), envelope.prepared.checklist.effect, envelope.prepared.result);
            return result.ok && !same(result.value, envelope.prepared.result)
                ? fail('INVALID_INPUT', 'Saved completion result does not match its journal') : result;
        },
        taskCompletionOutcome(input: NativeTaskCompletionEnvelope): NativeHostResult<NativeTaskCompletionResult | null> {
            const envelope = readCompletion(input, deps.validateField);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared completion is malformed');
            const saved = (envelope.prepared.version === 2 ? historyRowReceipts : deps.receipts).saved<NativeTaskCompletionResult>(envelope.request.requestId,
                canonicalJSON([envelope.prepared.version === 2 ? rawWritePrefix(envelope as NativeRawReferenceEnvelope) : 'taskCompletion', envelope]));
            return saved?.ok && !same(saved.value, envelope.prepared.result)
                ? fail('INVALID_INPUT', 'Saved completion result does not match its journal')
                : saved ?? { ok: true, value: null };
        },
        prepareTaskCompletionUndo: prepareCompletionUndo,
        validatePreparedTaskCompletionUndo(input: NativeTaskCompletionUndoEnvelope): NativeHostResult<{ id: string }> {
            const envelope = readCompletionUndo(input, deps.validateField);
            return envelope ? { ok: true, value: envelope.prepared.result }
                : fail('INVALID_INPUT', 'Prepared completion Undo is malformed');
        },
        taskCompletionUndoOutcome(input: NativeTaskCompletionUndoEnvelope): NativeHostResult<{ id: string } | null> {
            const envelope = readCompletionUndo(input, deps.validateField);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared completion Undo is malformed');
            const saved = (envelope.prepared.version === 2 ? historyRowReceipts : deps.receipts).saved<{ id: string }>(envelope.request.requestId,
                canonicalJSON([envelope.prepared.version === 2 ? rawWritePrefix(envelope as NativeRawReferenceEnvelope) : 'taskCompletionUndo', envelope]));
            return saved?.ok && !same(saved.value, envelope.prepared.result)
                ? fail('INVALID_INPUT', 'Saved completion Undo result does not match its journal')
                : saved ?? { ok: true, value: null };
        },
        async commitPreparedTaskCompletionUndo(input: NativeTaskCompletionUndoEnvelope): Promise<NativeHostResult<{ id: string }>> {
            const envelope = readCompletionUndo(input, deps.validateField);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared completion Undo is malformed');
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (envelope.prepared.kind === 'referenceCompleteUndo' || envelope.prepared.kind === 'boardCompleteUndo') return commitHistoryRowWrite(envelope as NativeRawReferenceEnvelope);
            const payload = canonicalJSON(['taskCompletionUndo', envelope]);
            const savedUndo = deps.receipts.saved<{ id: string }>(envelope.request.requestId, payload);
            if (savedUndo) return savedUndo.ok && !same(savedUndo.value, envelope.prepared.result)
                ? fail('INVALID_INPUT', 'Saved completion Undo result does not match its journal') : savedUndo;
            const confirmed = deps.receipts.saved<NativeTaskCompletionResult>(envelope.prepared.completion.request.requestId,
                canonicalJSON(['taskCompletion', envelope.prepared.completion]));
            if (!confirmed?.ok || !same(confirmed.value, envelope.prepared.completion.prepared.result))
                return fail('STALE_REVISION', 'Completion has no saved request receipt');
            const result = await commitReceipted(envelope.request.requestId, payload,
                envelope.prepared.effect, envelope.prepared.result);
            return result.ok && !same(result.value, envelope.prepared.result)
                ? fail('INVALID_INPUT', 'Saved completion Undo result does not match its journal') : result;
        },
        prepareTaskChecklistSave: (request: NativeChecklistSaveRequest): NativeHostResult<NativeChecklistPreparation> =>
            isHistoryRowRequest(request) ? fail('INVALID_INPUT', 'Done status requires its row request') : prepare('save', request),
        prepareTaskChecklistReset: (request: NativeChecklistResetRequest): NativeHostResult<NativeChecklistPreparation> => prepare('reset', request),
        /** Pure journal authority check, valid before storage activation and terminal cleanup. */
        validatePreparedTaskChecklistWrite(input: { request: NativeChecklistWriteRequest; prepared: NativePreparedChecklistWrite }): NativeHostResult<NativeChecklistResult> {
            const prepared = readPrepared(input, deps.validateField);
            return prepared && !isHistoryRowRequest(prepared.request) ? { ok: true, value: prepared.result }
                : fail('INVALID_INPUT', 'Prepared checklist request or journal does not match');
        },
        async commitPreparedTaskChecklistWrite(input: { request: NativeChecklistWriteRequest; prepared: NativePreparedChecklistWrite }): Promise<NativeHostResult<NativeChecklistResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPrepared(input, deps.validateField);
            if (!prepared || isHistoryRowRequest(prepared.request))
                return fail('INVALID_INPUT', 'Prepared checklist request or journal does not match');
            return commitEffect(prepared.effect, prepared.result);
        },
        prepareTaskCancellationUndo(input: { request: NativeTaskCancellationUndoRequest; cancel: NativeChecklistCancellationEnvelope }): NativeHostResult<
            { kind: 'prepared'; prepared: NativePreparedTaskCancellationUndo }> {
            return prepareCancellationUndo(input) as NativeHostResult<{ kind: 'prepared'; prepared: NativePreparedTaskCancellationUndo }>;
        },
        validatePreparedTaskCancellationUndo(input: NativeTaskCancellationUndoEnvelope): NativeHostResult<{ id: string }> {
            const envelope = readPreparedUndo(input, deps.validateField);
            return envelope ? { ok: true, value: envelope.prepared.result }
                : fail('INVALID_INPUT', 'Prepared cancellation Undo is malformed');
        },
        async commitPreparedTaskCancellationUndo(input: NativeTaskCancellationUndoEnvelope): Promise<NativeHostResult<{ id: string }>> {
            const envelope = readPreparedUndo(input, deps.validateField);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared cancellation Undo is malformed');
            const ready = deps.readiness();
            return ready.ok ? commitEffect(envelope.prepared.effect, envelope.prepared.result) : ready;
        },
    };
    return { publicMethods, ownedAuthority };
}

export function createTaskChecklistSaveMethods(deps: NativeTaskChecklistSaveDependencies) {
    return createTaskChecklistSaveFactory(deps).publicMethods;
}

/** Internal complete-owned factory; ordinary methods cannot select file authority. */
export function createOwnedCompleteTaskChecklistSaveAuthority(deps: NativeTaskChecklistSaveDependencies) {
    return createTaskChecklistSaveFactory(deps).ownedAuthority;
}
