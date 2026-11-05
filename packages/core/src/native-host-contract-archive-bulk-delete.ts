import type { NativeHostResult } from './native-host-contract';
import type { AppData, Area, Project, Section, Task } from './types';
import type { PreparedAreaAuthority, PreparedNativeSaveBoundary } from './store-types';
import { exact, iso, record, validProject } from './native-host-contract-project-shared';
import { validSection } from './native-host-contract-project-section-rename';
import { validRawTask } from './native-host-contract-task-save';
import { historyRowLoadProjection } from './native-host-contract-task-checklist';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { createAreaSaveGuard, readAreaDurableData } from './native-host-contract-area-durable';
import { createNativeRequestReceipts, isNativeRequestReceiptDurable, NativeReceiptSqliteAdapter, taskRevisionOf } from './native-request-receipts';
import { taskEditValuesEqual } from './json-value-equality';
import { buildEntityMap, ensureDeviceId } from './store-helpers';
import { planTaskMutations, sanitizeRestoredTaskContainerReferences } from './store-tasks';
import { getStorageAdapter, useTaskStore } from './store';
import { isProjectedRecurringTaskId } from './recurrence';
import { formatListItemCount } from './list-count';
import { getTrashUndoLabel } from './trash-view-model';
import { logInfo } from './logger';
import { isStatusListTaskReadOnly } from './menu-views-model';
import { isTaskVisibleInInbox } from './area-filter';
import { rawReadProjectSnapshot, rawReadTaskSnapshot } from './sqlite-raw-snapshot';
import type { NativeProjectTasksDeleteRequest } from './native-host-contract-project-bulk-delete';
import { readStatusBatchSelectionRequest, statusBatchSourcesMatch, statusBatchSettings, referenceTasksMoveScope,
    rawReferenceBatchScope, requiredReferenceBatchDates, validReferenceBatchTask, validReferenceBatchProject,
    validReferenceBatchArea, referenceBatchSettingsReadable, type NativeReferenceTasksMoveScope, type NativeShownSelection } from './native-host-contract-reference-bulk-status';
import { validFrozenFocusDate } from './native-host-contract-task-focus';
import { projectFocusDateValues, type FocusDateProjection } from './task-utils';

export type NativeArchivedTasksDeleteRequest = { requestId: string; taskIds: string[]; taskRevisions: Record<string, string> } & (
    | { source?: 'done' | 'reference' | 'inbox' | 'waiting' | 'someday' }
    | { source: 'review' | 'contexts'; params: Record<string, unknown> });
export type NativeArchivedTasksDeleteResult = { count: number; deletion: { message: string; undoLabel: string; undoEnabled: true } };
export type NativePreparedArchivedTasksDelete = {
    version: 1; request: NativeArchivedTasksDeleteRequest; before: Task[]; after: Task[];
    deviceIdBefore: string | null; deviceIdToInitialize: string | null; updateAt: string;
    result: NativeArchivedTasksDeleteResult; projects?: Project[];
};
export type NativeArchivedTasksDeleteEnvelope = { request: NativeArchivedTasksDeleteRequest; prepared: NativePreparedArchivedTasksDelete };
export type NativeArchivedTasksDeletePreparation = { kind: 'prepared'; prepared: NativePreparedArchivedTasksDelete };
export type NativeArchivedTasksDeleteUndoRequest = { requestId: string; deleteRequestId: string };
export type NativeArchivedTasksDeleteUndoResult = { count: number };
export type NativeArchivedTasksDeleteUndoScope = { projects: Project[]; sections: Section[]; areas: Area[] };
export type NativePreparedArchivedTasksDeleteUndo = {
    version: 1; request: NativeArchivedTasksDeleteUndoRequest; delete: NativeArchivedTasksDeleteEnvelope;
    before: Task[]; after: Task[]; scope: NativeArchivedTasksDeleteUndoScope;
    deviceIdBefore: string | null; deviceIdToInitialize: string | null; updateAt: string;
    result: NativeArchivedTasksDeleteUndoResult;
};
export type NativeArchivedTasksDeleteUndoEnvelope = { request: NativeArchivedTasksDeleteUndoRequest; prepared: NativePreparedArchivedTasksDeleteUndo };
export type NativeArchivedTasksDeleteUndoPreparation = { kind: 'prepared'; prepared: NativePreparedArchivedTasksDeleteUndo };
export type NativeArchivedTasksDeleteUndoPrepareRequest = { request: NativeArchivedTasksDeleteUndoRequest; delete: NativeArchivedTasksDeleteEnvelope };
type Source = 'legacy' | 'project';
type DeleteRequest = NativeArchivedTasksDeleteRequest | NativeProjectTasksDeleteRequest;
type Frozen = { preparedLocalDay: string; preparedOffsetMinutes: number; boundaryOffsetMinutes: number;
    futureBoundary: string; dates: FocusDateProjection[] };
type DeletePrepared = Omit<NativePreparedArchivedTasksDelete, 'request'> & { request: DeleteRequest; scope?: NativeReferenceTasksMoveScope } & Partial<Frozen>;
type DeleteEnvelope = { request: DeleteRequest; prepared: DeletePrepared };
type UndoPrepared = Omit<NativePreparedArchivedTasksDeleteUndo, 'delete'> & { delete: DeleteEnvelope } & Partial<Frozen>;
type UndoEnvelope = { request: NativeArchivedTasksDeleteUndoRequest; prepared: UndoPrepared };
type MutationEnvelope = DeleteEnvelope | UndoEnvelope;
const projectSelection = (request: NativeProjectTasksDeleteRequest) => ({ ...request, status: 'next' as const });
const temporal = (prepared: Partial<Frozen>): { futureBoundary: string; dates: ReadonlyMap<string, FocusDateProjection> } | undefined => prepared.futureBoundary && prepared.dates
    ? { futureBoundary: prepared.futureBoundary, dates: new Map(prepared.dates.map(row => [row.value, row])) } : undefined;
const taskDates = (tasks: Task[]) => requiredReferenceBatchDates({ tasks, projects: [], sections: [], areas: [], settings: {} });
const captureTemporal = (at: string, tasks: Task[]): Frozen => {
    const now = new Date(at), end = new Date(now); end.setHours(23, 59, 59, 999);
    return { preparedLocalDay: new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10),
        preparedOffsetMinutes: now.getTimezoneOffset(), boundaryOffsetMinutes: end.getTimezoneOffset(),
        futureBoundary: end.toISOString(), dates: projectFocusDateValues(taskDates(tasks)) };
};
const frozenKeys = ['preparedLocalDay', 'preparedOffsetMinutes', 'boundaryOffsetMinutes', 'futureBoundary', 'dates'];
const validTemporal = (raw: Record<string, unknown>, tasks: Task[]): boolean => {
    if (typeof raw.preparedLocalDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.preparedLocalDay)
        || !Number.isInteger(raw.preparedOffsetMinutes) || Math.abs(raw.preparedOffsetMinutes as number) > 840
        || !Number.isInteger(raw.boundaryOffsetMinutes) || Math.abs(raw.boundaryOffsetMinutes as number) > 840
        || !iso(raw.futureBoundary) || !Array.isArray(raw.dates) || !raw.dates.every(validFrozenFocusDate)) return false;
    return new Date(Date.parse(raw.updateAt as string) - (raw.preparedOffsetMinutes as number) * 60_000).toISOString().slice(0, 10) === raw.preparedLocalDay
        && new Date(Date.parse(raw.preparedLocalDay + 'T23:59:59.999Z') + (raw.boundaryOffsetMinutes as number) * 60_000).toISOString() === raw.futureBoundary
        && same(taskDates(tasks), raw.dates.map(row => row.value));
};
const projectScope = (request: NativeProjectTasksDeleteRequest, data: NativeReferenceTasksMoveScope) =>
    rawReferenceBatchScope(referenceTasksMoveScope(projectSelection(request), data));
const validProjectScope = (scope: unknown): scope is NativeReferenceTasksMoveScope => record(scope)
    && exact(scope, ['tasks', 'projects', 'sections', 'areas', 'settings'])
    && Array.isArray(scope.tasks) && unique(scope.tasks) && scope.tasks.every(validReferenceBatchTask)
    && Array.isArray(scope.projects) && unique(scope.projects) && scope.projects.every(validReferenceBatchProject)
    && Array.isArray(scope.sections) && unique(scope.sections) && scope.sections.every(row => record(row) && text(row.id, 500) && text(row.projectId, 500) && validSection(row, row.id, row.projectId))
    && Array.isArray(scope.areas) && unique(scope.areas) && scope.areas.every(validReferenceBatchArea)
    && record(scope.settings) && same(statusBatchSettings(scope.settings, 'project'), scope.settings);
type MutationResult = NativeArchivedTasksDeleteResult | NativeArchivedTasksDeleteUndoResult;

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const same = taskEditValuesEqual;
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= limit;
const notice = (value: unknown, limit: number): value is string => text(value, limit) && Array.from(value).every((part) => part.charCodeAt(0) >= 32 && part.charCodeAt(0) !== 127);
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> => ({ ok: false, error: { code, message } });
const unique = (rows: { id: string }[]) => new Set(rows.map((row) => row.id)).size === rows.length;
const canonicalPayload = (value: unknown): string => JSON.stringify(value, (_name, item) => record(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);

const revisionPaths = new Set(['taskRevisions', 'request.taskRevisions', 'prepared.request.taskRevisions',
    'delete.request.taskRevisions', 'delete.prepared.request.taskRevisions',
    'prepared.delete.request.taskRevisions', 'prepared.delete.prepared.request.taskRevisions']);
const detach = <T>(value: unknown): T | null => {
    const valid = (item: unknown, depth: number, path: string): boolean => {
        if (depth > 24) return false;
        if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
        if (typeof item === 'number') return Number.isFinite(item);
        if (Array.isArray(item)) return item.length <= 100_000 && item.every((part) => valid(part, depth + 1, `${path}[]`));
        return record(item) && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)
            && Object.keys(item).length <= (revisionPaths.has(path) ? 10_000 : 128)
            && Object.entries(item).every(([name, part]) => !['__proto__', 'constructor', 'prototype'].includes(name)
                && valid(part, depth + 1, path ? `${path}.${name}` : name));
    };
    if (!isNativeJsonWithinBytes(value) || !valid(value, 0, '')) return null;
    return JSON.parse(JSON.stringify(value)) as T;
};
const jsonSafe = <T>(value: unknown): T | null => { try { return detach<T>(JSON.parse(JSON.stringify(value))); } catch { return null; } };
const readDeleteRequest = (input: unknown, source: Source): DeleteRequest | null => {
    const request = detach<Record<string, unknown>>(input);
    if (source === 'project') return request && exact(request, ['requestId', 'source', 'taskIds', 'taskRevisions', 'params'])
        && readStatusBatchSelectionRequest({ ...request, status: 'next' }, 'project') ? request as NativeProjectTasksDeleteRequest : null;
    const shown = request && isShown(request.source as DeleteRequest['source']);
    if (shown && !(exact(request, ['requestId', 'source', 'taskIds', 'taskRevisions', 'params'])
        && readStatusBatchSelectionRequest({ ...request, status: 'next' }, request.source as 'review'))) return null;
    if (!request || !exact(request, shown ? ['requestId', 'source', 'taskIds', 'taskRevisions', 'params']
        : ['done', 'reference', 'inbox', 'waiting', 'someday'].includes(request.source as string) ? ['requestId', 'taskIds', 'taskRevisions', 'source'] : ['requestId', 'taskIds', 'taskRevisions'])
        || typeof request.requestId !== 'string' || !UUID.test(request.requestId)
        || !Array.isArray(request.taskIds) || !request.taskIds.length || request.taskIds.length > 10_000
        || !request.taskIds.every((id) => text(id, 500)) || new Set(request.taskIds).size !== request.taskIds.length
        || !record(request.taskRevisions) || !exact(request.taskRevisions, request.taskIds)
        || !Object.values(request.taskRevisions).every((revision) => text(revision, 200))) return null;
    return request as NativeArchivedTasksDeleteRequest;
};
const readUndoRequest = (input: unknown): NativeArchivedTasksDeleteUndoRequest | null => {
    const request = detach<Record<string, unknown>>(input);
    return request && exact(request, ['requestId', 'deleteRequestId']) && typeof request.requestId === 'string'
        && UUID.test(request.requestId) && typeof request.deleteRequestId === 'string' && UUID.test(request.deleteRequestId)
        && request.requestId !== request.deleteRequestId ? request as NativeArchivedTasksDeleteUndoRequest : null;
};
const validTask = (row: unknown): row is Task => record(row) && text(row.id, 500) && validRawTask(row, row.id);
const validReferenceTask = (row: unknown): row is Task => record(row) && text(row.id, 500)
    && validRawTask({ ...row, tags: row.tags ?? [], contexts: row.contexts ?? [] }, row.id);
const validDevice = (raw: Record<string, unknown>) => (raw.deviceIdBefore === null || text(raw.deviceIdBefore, 500))
    && (raw.deviceIdBefore === null ? typeof raw.deviceIdToInitialize === 'string' && UUID.test(raw.deviceIdToInitialize) : raw.deviceIdToInitialize === null)
    && iso(raw.updateAt);
const selectedRows = (ids: readonly string[], tasks: readonly Task[]): Task[] => {
    const selected = new Set(ids); return tasks.filter((row) => selected.has(row.id));
};
const referenceRows = (tasks: readonly Task[]): Task[] | null => {
    const snapshots = tasks.map(rawReadTaskSnapshot);
    return snapshots.every((row) => row !== null) ? snapshots as Task[] : null;
};
const referenceProjects = (projects: readonly Project[]): Project[] | null => {
    const snapshots = projects.map(rawReadProjectSnapshot);
    return snapshots.every((row) => row !== null) ? snapshots as Project[] : null;
};
// These sources bind raw JSON and durable origin receipts without sharing source identity.
const usesRawSnapshots = (source: DeleteRequest['source']): boolean => source === 'reference' || source === 'inbox' || source === 'project' || isStatusList(source);
const isShown = (source: DeleteRequest['source']): source is 'review' | 'contexts' => source === 'review' || source === 'contexts';
const isStatusList = (source: DeleteRequest['source']): source is 'waiting' | 'someday' | 'review' | 'contexts' => source === 'waiting' || source === 'someday' || isShown(source);
const STATUS_LIST_NAMES = { waiting: 'Waiting', someday: 'Someday', review: 'Review', contexts: 'Contexts' } as const;
const unreadableRaw = (source: string): NativeHostResult<never> => fail('SAVE_FAILED', `Saved ${source} raw JSON could not be bound safely`);
const deleteProjects = (tasks: readonly Task[], projects: readonly Project[]): Project[] => {
    const ids = new Set(tasks.flatMap((row) => row.projectId ? [row.projectId] : []));
    return projects.filter((row) => ids.has(row.id));
};
const selectedSourcesMatch = (request: NativeArchivedTasksDeleteRequest, tasks: Task[], projects: readonly Project[] = []): boolean => {
    if (tasks.length !== request.taskIds.length || !unique(tasks)) return false;
    const byId = buildEntityMap(tasks); const projectById = buildEntityMap(projects);
    return request.taskIds.every((id) => { const row = byId.get(id); return row && (isShown(request.source) ? row.status !== 'archived' : row.status === (request.source ?? 'archived'))
        && !row.deletedAt && !row.purgedAt && !isProjectedRecurringTaskId(id) && taskRevisionOf(row) === request.taskRevisions[id]
        && (!request.source || !isStatusListTaskReadOnly(row, projects))
        && (request.source !== 'inbox' || isTaskVisibleInInbox(row, { projectById })); });
};
const deleteAfter = (prepared: Pick<DeletePrepared, 'before' | 'updateAt' | 'deviceIdBefore' | 'deviceIdToInitialize'> & Partial<Frozen>): Task[] =>
    planTaskMutations({ tasks: prepared.before.map((row) => historyRowLoadProjection(row, prepared.updateAt, temporal(prepared))), state: {},
        buildUpdates: (_task, { now }) => ({ deletedAt: now }), now: prepared.updateAt,
        deviceId: prepared.deviceIdBefore ?? prepared.deviceIdToInitialize! });


export const archivedTasksDeleteUndoScope = (tasks: readonly Task[], data: Pick<AppData, 'projects' | 'sections' | 'areas'>): NativeArchivedTasksDeleteUndoScope => {
    const sectionIds = new Set(tasks.flatMap((row) => row.sectionId ? [row.sectionId.trim()] : []));
    const sections = data.sections.filter((row) => sectionIds.has(row.id));
    const projectIds = new Set([...tasks.flatMap((row) => row.projectId ? [row.projectId.trim()] : []), ...sections.map((row) => row.projectId)]);
    const areaIds = new Set(tasks.flatMap((row) => row.areaId ? [row.areaId.trim()] : []));
    return { projects: data.projects.filter((row) => projectIds.has(row.id)), sections,
        areas: data.areas.filter((row) => areaIds.has(row.id)) };
};
const undoAfter = (prepared: Pick<UndoPrepared, 'before' | 'scope' | 'updateAt' | 'deviceIdBefore' | 'deviceIdToInitialize'> & Partial<Frozen>): Task[] =>
    planTaskMutations({ tasks: prepared.before.map((row) => historyRowLoadProjection(row, prepared.updateAt, temporal(prepared))),
        state: { _allProjects: prepared.scope.projects, _allSections: prepared.scope.sections, _allAreas: prepared.scope.areas },
        buildUpdates: (task, { state }) => ({ deletedAt: undefined, ...sanitizeRestoredTaskContainerReferences(task, state) }),
        now: prepared.updateAt, deviceId: prepared.deviceIdBefore ?? prepared.deviceIdToInitialize! });
const validArea = (row: unknown): row is Area => record(row) && text(row.id, 500) && typeof row.name === 'string'
    && iso(row.createdAt) && iso(row.updatedAt) && (row.deletedAt === undefined || iso(row.deletedAt));
const validContextProject = (row: unknown): row is Project => record(row) && text(row.id, 500)
    && (row.deletedAt === undefined || iso(row.deletedAt)) && (row.purgedAt === undefined || iso(row.purgedAt))
    && validProject({ ...row, deletedAt: undefined, purgedAt: undefined }, row.id);

const validReferenceContextProject = (row: unknown): row is Project => record(row) && text(row.id, 500)
    && (row.deletedAt === undefined || iso(row.deletedAt)) && (row.purgedAt === undefined || iso(row.purgedAt))
    && validProject({ ...row, tagIds: row.tagIds ?? [], deletedAt: undefined, purgedAt: undefined,
        ...(Array.isArray(row.attachments) ? { attachments: row.attachments.map((attachment) => record(attachment)
            && (attachment.updatedAt === undefined || attachment.updatedAt === '')
            ? { ...attachment, updatedAt: attachment.createdAt } : attachment) } : {}) }, row.id);
const undoScope = (tasks: readonly Task[], data: Pick<AppData, 'projects' | 'sections' | 'areas'>, reference: boolean): NativeArchivedTasksDeleteUndoScope | null => {
    const scope = archivedTasksDeleteUndoScope(tasks, data);
    if (!reference) return scope;
    const projects = referenceProjects(scope.projects);
    return projects ? { ...scope, projects } : null;
};
const validScope = (scope: unknown, reference = false): scope is NativeArchivedTasksDeleteUndoScope => record(scope) && exact(scope, ['projects', 'sections', 'areas'])
    && Array.isArray(scope.projects) && unique(scope.projects) && scope.projects.every(reference ? validReferenceContextProject : validContextProject)
    && Array.isArray(scope.sections) && unique(scope.sections) && scope.sections.every((row) => record(row) && text(row.id, 500)
        && text(row.projectId, 500) && validSection(row, row.id, row.projectId))
    && Array.isArray(scope.areas) && unique(scope.areas) && scope.areas.every(validArea);
const readDelete = (input: unknown, source: Source): DeleteEnvelope | null => {
    const envelope = detach<Record<string, unknown>>(input);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readDeleteRequest(envelope.request, source); const raw = envelope.prepared;
    const keys = ['version', 'request', 'before', 'after', 'deviceIdBefore', 'deviceIdToInitialize', 'updateAt', 'result'];
    const project = request?.source === 'project';
    if (project) keys.push('scope', ...frozenKeys); else if (request?.source) keys.push('projects');
    if (!request || !exact(raw, keys)
        || raw.version !== 1 || !same(raw.request, request) || !validDevice(raw)
        || !Array.isArray(raw.before) || !raw.before.every(usesRawSnapshots(request.source) ? validReferenceTask : validTask)
        || (!project && request.source && (!Array.isArray(raw.projects) || !unique(raw.projects) || !raw.projects.every(usesRawSnapshots(request.source) ? validReferenceContextProject : validContextProject)
            || !same(deleteProjects(raw.before, raw.projects), raw.projects)))
        || (!project && !selectedSourcesMatch(request as NativeArchivedTasksDeleteRequest, raw.before, request.source ? raw.projects as Project[] : []))
        || !Array.isArray(raw.after) || !raw.after.every(validTask) || !record(raw.result) || !exact(raw.result, ['count', 'deletion'])
        || raw.result.count !== request.taskIds.length || !record(raw.result.deletion) || !exact(raw.result.deletion, ['message', 'undoLabel', 'undoEnabled'])
        || !notice(raw.result.deletion.message, 512) || !notice(raw.result.deletion.undoLabel, 80) || raw.result.deletion.undoEnabled !== true) return null;
    try { const prepared = raw as unknown as DeletePrepared;
        if (request.source === 'project' && (!validProjectScope(raw.scope) || !validTemporal(raw, raw.scope.tasks)
            || !same(projectScope(request, raw.scope), raw.scope) || !same(selectedRows(request.taskIds, raw.scope.tasks), raw.before)
            || !statusBatchSourcesMatch(projectSelection(request), raw.scope, prepared.updateAt, temporal(prepared))
            || (raw.scope.settings.deviceId ?? null) !== prepared.deviceIdBefore)) return null;
        return same(deleteAfter(prepared), prepared.after) ? envelope as unknown as DeleteEnvelope : null;
    } catch { return null; }
};
const readUndo = (input: unknown, source: Source): UndoEnvelope | null => {
    const envelope = detach<Record<string, unknown>>(input);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readUndoRequest(envelope.request); const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'delete', 'before', 'after', 'scope', 'deviceIdBefore', 'deviceIdToInitialize', 'updateAt', 'result', ...(source === 'project' ? frozenKeys : [])])
        || raw.version !== 1 || !same(raw.request, request) || !validDevice(raw)
        || !Array.isArray(raw.before) || !raw.before.every(validTask) || !Array.isArray(raw.after) || !raw.after.every(validTask)
        || !record(raw.result) || !exact(raw.result, ['count'])) return null;
    const deletion = readDelete(raw.delete, source);
    if (!deletion || !validScope(raw.scope, usesRawSnapshots(deletion.request.source)) || deletion.request.requestId !== request.deleteRequestId || !same(raw.before, deletion.prepared.after)
        || raw.result.count !== deletion.prepared.result.count) return null;
    try { const prepared = raw as unknown as UndoPrepared;
        if (source === 'project' && (!validTemporal(raw, prepared.before) || Date.parse(prepared.updateAt) < Date.parse(deletion.prepared.updateAt))) return null;
        return same(archivedTasksDeleteUndoScope(prepared.before, prepared.scope), prepared.scope) && same(undoAfter(prepared), prepared.after)
            ? envelope as unknown as UndoEnvelope : null;
    } catch { return null; }
};
const isUndo = (envelope: MutationEnvelope): envelope is UndoEnvelope => 'delete' in envelope.prepared;
const isProject = (envelope: MutationEnvelope): boolean => (isUndo(envelope) ? envelope.prepared.delete.request : envelope.request).source === 'project';
const isDone = (envelope: MutationEnvelope): boolean => (isUndo(envelope) ? envelope.prepared.delete.request : envelope.request).source === 'done';
const isReference = (envelope: MutationEnvelope): boolean => (isUndo(envelope) ? envelope.prepared.delete.request : envelope.request).source === 'reference';
const isInbox = (envelope: MutationEnvelope): boolean => (isUndo(envelope) ? envelope.prepared.delete.request : envelope.request).source === 'inbox';
const statusListOf = (envelope: MutationEnvelope): 'waiting' | 'someday' | 'review' | 'contexts' | null => {
    const source = (isUndo(envelope) ? envelope.prepared.delete.request : envelope.request).source;
    return isStatusList(source) ? source : null;
};
const requiresRawSnapshots = (envelope: MutationEnvelope): boolean => usesRawSnapshots((isUndo(envelope) ? envelope.prepared.delete.request : envelope.request).source);
const sourceName = (envelope: MutationEnvelope): string => statusListOf(envelope) ? STATUS_LIST_NAMES[statusListOf(envelope)!] : isProject(envelope) ? 'Project' : isInbox(envelope) ? 'Inbox' : isReference(envelope) ? 'Reference' : isDone(envelope) ? 'Done' : 'Archive';
// Preserve existing Archive wording on Done's legacy raw-safety error branches.
const rawSourceName = (envelope: MutationEnvelope): string => statusListOf(envelope) ? STATUS_LIST_NAMES[statusListOf(envelope)!] : isProject(envelope) ? 'Project' : isInbox(envelope) ? 'Inbox' : isReference(envelope) ? 'Reference' : 'Archive';
const requestSourceName = (request: DeleteRequest): string => isStatusList(request.source) ? STATUS_LIST_NAMES[request.source] : request.source === 'project' ? 'Project' : request.source === 'inbox' ? 'Inbox' : request.source === 'reference' ? 'Reference' : request.source === 'done' ? 'Done' : 'Archive';
const buildUndo = (request: NativeArchivedTasksDeleteUndoRequest, deletion: DeleteEnvelope,
    data: Pick<AppData, 'projects' | 'sections' | 'areas' | 'settings'>, updateAt: string): UndoEnvelope | null => {
    const scope = undoScope(deletion.prepared.after, data, requiresRawSnapshots(deletion)); if (!scope) return null;
    const device = ensureDeviceId(data.settings);
    const base = { version: 1 as const, request, delete: deletion, before: deletion.prepared.after,
        scope, ...(isProject(deletion) ? captureTemporal(updateAt, deletion.prepared.after) : {}), deviceIdBefore: data.settings.deviceId ?? null,
        deviceIdToInitialize: device.updated ? device.deviceId : null, updateAt, result: { count: deletion.prepared.result.count } };
    try { return jsonSafe<UndoEnvelope>({ request, prepared: { ...base, after: undoAfter(base) } }); }
    catch { return null; }
};
const prospectiveUndoFits = (deletion: DeleteEnvelope, data: Pick<AppData, 'projects' | 'sections' | 'areas' | 'settings'>): boolean => {
    const dummy = deletion.request.requestId === '00000000-0000-4000-8000-000000000000'
        ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000000';
    const settings = deletion.prepared.deviceIdToInitialize ? { ...data.settings, deviceId: deletion.prepared.deviceIdToInitialize } : data.settings;
    const undo = buildUndo({ requestId: dummy, deleteRequestId: deletion.request.requestId }, deletion, { ...data, settings }, deletion.prepared.updateAt);
    return Boolean(undo && readUndo(undo, isProject(deletion) ? 'project' : 'legacy'));
};

export function createTasksDeleteMethods(deps: {
    readiness: () => NativeHostResult<null>; save: () => Promise<NativeHostResult<null>>; t: () => (key: string) => string; shown?: NativeShownSelection;
}, source: Source) {
    const guarded = (): NativeHostResult<null> => source !== 'project' || (isNativeRequestReceiptDurable('projectTasksDelete') && isNativeRequestReceiptDurable('projectTasksDeleteUndo'))
        ? { ok: true, value: null } : fail('SAVE_FAILED', 'Project Trash receipt storage is unavailable');
    const saves = createAreaSaveGuard(deps.save);
    let pending: { envelope: MutationEnvelope; adapter: ReturnType<typeof getStorageAdapter>; boundary: PreparedNativeSaveBoundary | undefined } | null = null;
    const payload = (envelope: MutationEnvelope) => canonicalPayload([
        isProject(envelope) ? (isUndo(envelope) ? 'projectTasksDeleteUndo' : 'projectTasksDelete')
            : statusListOf(envelope) ? `${statusListOf(envelope)}TasksDelete${isUndo(envelope) ? 'Undo' : ''}`
            : isInbox(envelope) ? (isUndo(envelope) ? 'inboxTasksDeleteUndo' : 'inboxTasksDelete')
            : isReference(envelope) ? (isUndo(envelope) ? 'referenceTasksDeleteUndo' : 'referenceTasksDelete')
            : isDone(envelope) ? (isUndo(envelope) ? 'doneTasksDeleteUndo' : 'doneTasksDelete')
            : (isUndo(envelope) ? 'archivedTasksDeleteUndo' : 'archivedTasksDelete'), envelope]);
    const savedResult = <T extends MutationResult>(envelope: MutationEnvelope): NativeHostResult<T> | null => {
        const saved = receipts.saved<T>(envelope.request.requestId, payload(envelope));
        return saved?.ok && !same(saved.value, envelope.prepared.result) ? fail('INVALID_INPUT', `Saved ${sourceName(envelope)} Trash result does not match its journal`) : saved;
    };
    const requireDeleteReceipt = (deletion: DeleteEnvelope): NativeHostResult<null> => {
        const saved = savedResult<NativeArchivedTasksDeleteResult>(deletion);
        if (saved && !saved.ok) return saved;
        return saved ? { ok: true, value: null } : fail('STALE_REVISION', `${sourceName(deletion)} Delete is not confirmed; retry its exact request before Undo`);
    };
    const requireDurableDeleteReceipt = async (deletion: DeleteEnvelope,
        adapter: ReturnType<typeof getStorageAdapter>): Promise<NativeHostResult<null>> => {
        if (!requiresRawSnapshots(deletion)) return requireDeleteReceipt(deletion);
        if (!(adapter instanceof NativeReceiptSqliteAdapter)) return fail('SAVE_FAILED', `${sourceName(deletion)} Undo requires readable durable receipts`);
        const saved = await adapter.readDurableReceipt(deletion.request.requestId, payload(deletion));
        if (!saved.ok) return saved;
        return saved.value !== null && same(saved.value, deletion.prepared.result) ? { ok: true, value: null }
            : fail('STALE_REVISION', `${sourceName(deletion)} Delete has no exact current durable receipt`);
    };
    const armDeleteReceipt = (envelope: MutationEnvelope, adapter: ReturnType<typeof getStorageAdapter>): (() => void) => {
        if (!isUndo(envelope) || !requiresRawSnapshots(envelope)) return () => undefined;
        if (!(adapter instanceof NativeReceiptSqliteAdapter)) throw new Error('Durable receipt storage changed');
        const deletion = envelope.prepared.delete; const key = payload(envelope);
        adapter.armReceiptPrerequisite(envelope.request.requestId, key, deletion.request.requestId, payload(deletion), deletion.prepared.result);
        return () => adapter.clearReceiptPrerequisite(envelope.request.requestId, key);
    };
    const checkAuthority = async (envelope: MutationEnvelope, authority: PreparedAreaAuthority,
        adapter: ReturnType<typeof getStorageAdapter>): Promise<NativeHostResult<null>> => {
        const prepared = envelope.prepared; const data = authority.snapshot;
        const selected = selectedRows(prepared.before.map((row) => row.id), data.tasks);
        const current = requiresRawSnapshots(envelope) ? referenceRows(selected) : selected;
        if (!current) return unreadableRaw(sourceName(envelope));
        if (!same(current, prepared.before) || (data.settings.deviceId ?? null) !== prepared.deviceIdBefore)
            return fail('STALE_REVISION', `${sourceName(envelope)} tasks changed since preparation`);
        if (isUndo(envelope)) {
            const proven = await requireDurableDeleteReceipt(envelope.prepared.delete, adapter); if (!proven.ok) return proven;
            const scope = undoScope(current, data, requiresRawSnapshots(envelope)); if (!scope) return unreadableRaw(sourceName(envelope));
            if (!same(scope, envelope.prepared.scope))
                return fail('STALE_REVISION', `${rawSourceName(envelope)} Undo containers changed since preparation`);
        } else {
            if (envelope.request.source === 'project') {
                if (!referenceBatchSettingsReadable(data.settings)) return unreadableRaw('Project settings');
                const scope = projectScope(envelope.request, data);
                if (!scope || !same(scope, envelope.prepared.scope)
                    || !statusBatchSourcesMatch(projectSelection(envelope.request), scope, prepared.updateAt, temporal(prepared)))
                    return fail('STALE_REVISION', 'Project selection or saved context changed since preparation');
            } else if (isDone(envelope) || requiresRawSnapshots(envelope)) {
                const parents = deleteProjects(current, data.projects);
                const projects = requiresRawSnapshots(envelope) ? referenceProjects(parents) : parents;
                if (!projects) return unreadableRaw(sourceName(envelope));
                if (!same(projects, envelope.prepared.projects)) return fail('STALE_REVISION', `${sourceName(envelope)} parent projects changed since preparation`);
            }
            if (envelope.request.source !== 'project' && !selectedSourcesMatch(envelope.request, current, data.projects)) return fail('STALE_REVISION', `${sourceName(envelope)} selection changed since it was shown`);
            if (requiresRawSnapshots(envelope) && !undoScope(current, data, true)) return unreadableRaw(sourceName(envelope));
            if (!prospectiveUndoFits(envelope, data)) return fail('INVALID_INPUT', `${rawSourceName(envelope)} Undo journal would be too large; select fewer tasks`);
        }
        return { ok: true, value: null };
    };
    const apply = (envelope: MutationEnvelope, authority: PreparedAreaAuthority) => {
        if (requiresRawSnapshots(envelope)) {


            const snapshots = referenceRows(selectedRows(envelope.prepared.before.map((row) => row.id), authority.snapshot.tasks));
            if (!snapshots) return Promise.resolve({ success: false as const, reason: 'conflict' as const, error: `Saved ${sourceName(envelope)} raw JSON could not be bound safely` });
            const selected = buildEntityMap(snapshots);
            authority.snapshot = { ...authority.snapshot, tasks: authority.snapshot.tasks.map((row) => selected.get(row.id) ?? row) };
        }
        return useTaskStore.getState().commitPreparedArchivedTasksMutation({
            before: envelope.prepared.before, after: envelope.prepared.after, deviceIdBefore: envelope.prepared.deviceIdBefore,
            deviceIdToInitialize: envelope.prepared.deviceIdToInitialize, operation: isUndo(envelope) ? 'undo' : 'delete',
            ...(isProject(envelope) ? { frozenTemporal: { at: envelope.prepared.updateAt, ...temporal(envelope.prepared)! } } : {}) }, authority);
    };
    const receipts = createNativeRequestReceipts({ save: async (requestId) => {
        const owned = pending;
        if (!owned || owned.envelope.request.requestId !== requestId) return fail('SAVE_FAILED', 'Archive Trash has no owned raw save');
        if (source === 'project') armDeleteReceipt(owned.envelope, owned.adapter);
        if (useTaskStore.getState().persistenceFailure) {
            if (!saves.mayApply(owned.envelope, owned.adapter)) return fail('SAVE_FAILED', `${rawSourceName(owned.envelope)} Trash has an unrelated persistence failure`);
            const read = await readAreaDurableData(true, true); if (!read.ok) return read;
            if (read.value.adapter !== owned.adapter) return fail('STALE_REVISION', `${rawSourceName(owned.envelope)} Trash storage changed before retry`);
            const checked = await checkAuthority(owned.envelope, read.value.authority, read.value.adapter); if (!checked.ok) return checked;
            const applied = await apply(owned.envelope, read.value.authority);
            if (!applied.success || applied.outcome !== 'applied') return fail('STALE_REVISION', applied.error ?? `${rawSourceName(owned.envelope)} Trash retry was superseded`);
            owned.boundary = read.value.authority.saveBoundary;
        } else if (isUndo(owned.envelope) && requiresRawSnapshots(owned.envelope)) {
            const proven = await requireDurableDeleteReceipt(owned.envelope.prepared.delete, owned.adapter); if (!proven.ok) return proven;
        }
        const saved = await saves.finish(owned.envelope, owned.adapter, false, owned.boundary);
        if (saved.ok) pending = null;
        return saved;
    } });
    const commit = async <T extends MutationResult>(envelope: MutationEnvelope): Promise<NativeHostResult<T>> => {
        const ready = deps.readiness(); if (!ready.ok) return ready;
        const available = guarded(); if (!available.ok) return available;
        const saved = savedResult<T>(envelope); if (saved) return saved;
        let prewriteFailure: NativeHostResult<never> | null = null;
        const notLanded = (message: string): NativeHostResult<never> => {
            prewriteFailure = fail('SAVE_FAILED', message); return { ok: false, error: { code: 'ACTION_FAILED', message } };
        };
        const confirmed = await receipts.run<T>(envelope.request.requestId, payload(envelope), async () => {
            if (useTaskStore.getState().persistenceFailure) return notLanded(`${rawSourceName(envelope)} Trash has an unresolved persistence failure`);
            const read = await readAreaDurableData(false, true);
            if (!read.ok) return read.error.code === 'SAVE_FAILED' ? notLanded(read.error.message) : read;
            const checked = await checkAuthority(envelope, read.value.authority, read.value.adapter);
            if (!checked.ok) return checked.error.code === 'SAVE_FAILED' ? notLanded(checked.error.message) : checked;
            const disarm = armDeleteReceipt(envelope, read.value.adapter);
            let applied: Awaited<ReturnType<typeof apply>>;
            try { applied = await apply(envelope, read.value.authority); } catch (error) { disarm(); throw error; }
            if (!applied.success || applied.outcome !== 'applied') { disarm(); return fail('STALE_REVISION', applied.error ?? `${rawSourceName(envelope)} Trash conflicts with saved data`); }
            pending = { envelope, adapter: read.value.adapter, boundary: read.value.authority.saveBoundary };
            return { ok: true, value: envelope.prepared.result as T };
        });
        if (prewriteFailure) return prewriteFailure;
        if (confirmed.ok && !same(confirmed.value, envelope.prepared.result)) return fail('INVALID_INPUT', `Saved ${sourceName(envelope)} Trash result does not match its journal`);
        if (confirmed.ok) { try { if (isProject(envelope)) logInfo('Native Project bulk Trash confirmed', { scope: 'native-host', category: 'storage', force: true,
            context: { releaseCheck: 'v1.3.9/ios-project-bulk-trash', count: confirmed.value.count, outcome: isUndo(envelope) ? 'restored' : 'deleted' } });
        else if (statusListOf(envelope)) logInfo(`Native ${sourceName(envelope)} bulk Trash confirmed`, { scope: 'native-host', category: 'storage', force: true,
            context: { releaseCheck: 'v1.3.9/ios-status-list-bulk-trash', count: confirmed.value.count, outcome: isUndo(envelope) ? 'restored' : 'deleted' } });
        else if (isInbox(envelope)) logInfo('Native Inbox bulk Trash confirmed', { scope: 'native-host', category: 'storage',
            context: { releaseCheck: 'v1.3.5/ios-inbox-bulk-trash', count: confirmed.value.count, outcome: isUndo(envelope) ? 'restored' : 'deleted' } });
        else if (isReference(envelope)) logInfo('Native Reference bulk Trash confirmed', { scope: 'native-host', category: 'storage',
            context: { releaseCheck: 'v1.3.4/ios-reference-bulk-trash', count: confirmed.value.count, outcome: isUndo(envelope) ? 'restored' : 'deleted' } });
        else logInfo(`Native ${sourceName(envelope)} bulk Trash confirmed`, { scope: 'native-host', category: 'storage',
            context: { releaseCheck: isDone(envelope) ? 'v1.3.4/ios-done-bulk-trash' : 'v1.3.4/ios-archive-bulk-trash', outcome: isUndo(envelope) ? 'restored' : 'deleted' } }); }
        catch {                                                               } }
        return confirmed;
    };
    return {
        async prepareArchivedTasksDelete(input: DeleteRequest): Promise<NativeHostResult<{ kind: 'prepared'; prepared: DeletePrepared }>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const available = guarded(); if (!available.ok) return available;
            const request = readDeleteRequest(input, source);
            if (!request) return fail('INVALID_INPUT', 'Select saved Archive tasks with exact revisions; select fewer tasks if the request is too large');
            const state = useTaskStore.getState();
            if (request.source === 'project' ? !statusBatchSourcesMatch(projectSelection(request), { tasks: state._allTasks, projects: state._allProjects, sections: state._allSections, areas: state._allAreas, settings: state.settings }, new Date().toISOString())
                : !selectedSourcesMatch(request, selectedRows(request.taskIds, state._allTasks), state._allProjects)
                    || (isShown(request.source) && deps.shown?.(request as never) !== true))
                return fail('STALE_REVISION', `${requestSourceName(request)} selection changed since it was shown`);
            const read = await readAreaDurableData(false, true); if (!read.ok) return read;
            const data = read.value.authority.snapshot; const selected = selectedRows(request.taskIds, data.tasks);
            const before = usesRawSnapshots(request.source) ? referenceRows(selected) : selected;
            if (!before) return unreadableRaw(requestSourceName(request));
            const parents = deleteProjects(before, data.projects);
            const projects = usesRawSnapshots(request.source) ? referenceProjects(parents) : parents;
            if (!projects || (usesRawSnapshots(request.source) && !undoScope(before, data, true))) return unreadableRaw(requestSourceName(request));
            if (request.source !== 'project' && !selectedSourcesMatch(request, before, data.projects)) return fail('STALE_REVISION', `Saved ${requestSourceName(request)} selection changed`);
            const updateAt = new Date().toISOString();
            const scope = request.source === 'project' ? projectScope(request, data) : null;
            if (request.source === 'project' && (!referenceBatchSettingsReadable(data.settings) || !scope)) return unreadableRaw('Project');
            const frozen = scope ? captureTemporal(updateAt, scope.tasks) : {};
            if (request.source === 'project' && (!scope || !statusBatchSourcesMatch(projectSelection(request), scope, updateAt, temporal(frozen))))
                return fail('STALE_REVISION', 'Saved Project selection changed');
            const device = ensureDeviceId(data.settings); const t = deps.t();
            const base = { version: 1 as const, request, before, ...(request.source === 'project' ? { scope: scope!, ...frozen } : request.source ? { projects } : {}),
                deviceIdBefore: data.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null, updateAt,
                result: { count: request.taskIds.length, deletion: { message: formatListItemCount(request.taskIds.length, 'task', t),
                    undoLabel: getTrashUndoLabel(t), undoEnabled: true as const } } };
            let command: DeleteEnvelope | null;
            try { command = jsonSafe({ request, prepared: { ...base, after: deleteAfter(base) } }); } catch { command = null; }
            return command && readDelete(command, source) && prospectiveUndoFits(command, data)
                ? { ok: true, value: { kind: 'prepared', prepared: command.prepared } }
                : fail('INVALID_INPUT', `${request.source === 'inbox' || request.source === 'reference' || isStatusList(request.source) ? requestSourceName(request) : 'Archive'} Delete or Undo journal is too large; select fewer tasks`);
        },
        validatePreparedArchivedTasksDelete(input: DeleteEnvelope): NativeHostResult<NativeArchivedTasksDeleteResult> {
            const envelope = readDelete(input, source); return envelope ? { ok: true, value: envelope.prepared.result } : fail('INVALID_INPUT', 'Prepared Archive Delete is malformed');
        },
        archivedTasksDeleteOutcome(input: DeleteEnvelope): NativeHostResult<NativeArchivedTasksDeleteResult | null> {
            const available = guarded(); if (!available.ok) return available;
            const envelope = readDelete(input, source); return envelope ? savedResult<NativeArchivedTasksDeleteResult>(envelope) ?? { ok: true, value: null }
                : fail('INVALID_INPUT', 'Prepared Archive Delete is malformed');
        },
        async commitPreparedArchivedTasksDelete(input: DeleteEnvelope): Promise<NativeHostResult<NativeArchivedTasksDeleteResult>> {
            const envelope = readDelete(input, source); return envelope ? commit<NativeArchivedTasksDeleteResult>(envelope) : fail('INVALID_INPUT', 'Prepared Archive Delete is malformed');
        },
        async prepareArchivedTasksDeleteUndo(input: { request: NativeArchivedTasksDeleteUndoRequest; delete: DeleteEnvelope }): Promise<NativeHostResult<{ kind: 'prepared'; prepared: UndoPrepared }>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const raw = detach<Record<string, unknown>>(input);
            const request = raw && exact(raw, ['request', 'delete']) ? readUndoRequest(raw.request) : null;
            const available = guarded(); if (!available.ok) return available;
            const deletion = raw ? readDelete(raw.delete, source) : null;
            if (!request || !deletion || request.deleteRequestId !== deletion.request.requestId) return fail('INVALID_INPUT', 'A confirmed bounded Archive Delete request is required for Undo');
            const proven = requiresRawSnapshots(deletion) ? null : requireDeleteReceipt(deletion); if (proven && !proven.ok) return proven;
            const read = await readAreaDurableData(false, true); if (!read.ok) return read;
            const durableProof = await requireDurableDeleteReceipt(deletion, read.value.adapter); if (!durableProof.ok) return durableProof;
            const data = read.value.authority.snapshot;
            const selected = selectedRows(deletion.request.taskIds, data.tasks);
            const current = requiresRawSnapshots(deletion) ? referenceRows(selected) : selected;
            if (!current || (requiresRawSnapshots(deletion) && !undoScope(deletion.prepared.after, data, true))) return unreadableRaw(sourceName(deletion));
            if (!same(current, deletion.prepared.after)) return fail('STALE_REVISION', `Deleted ${rawSourceName(deletion)} tasks changed before Undo`);
            const command = buildUndo(request, deletion, data, new Date().toISOString());
            return command && readUndo(command, source) ? { ok: true, value: { kind: 'prepared', prepared: command.prepared } }
                : fail('INVALID_INPUT', `${rawSourceName(deletion)} Undo journal is too large; select fewer tasks`);
        },
        validatePreparedArchivedTasksDeleteUndo(input: UndoEnvelope): NativeHostResult<NativeArchivedTasksDeleteUndoResult> {
            const envelope = readUndo(input, source); return envelope ? { ok: true, value: envelope.prepared.result } : fail('INVALID_INPUT', 'Prepared Archive Undo is malformed');
        },
        archivedTasksDeleteUndoOutcome(input: UndoEnvelope): NativeHostResult<NativeArchivedTasksDeleteUndoResult | null> {
            const available = guarded(); if (!available.ok) return available;
            const envelope = readUndo(input, source); return envelope ? savedResult<NativeArchivedTasksDeleteUndoResult>(envelope) ?? { ok: true, value: null }
                : fail('INVALID_INPUT', 'Prepared Archive Undo is malformed');
        },
        async commitPreparedArchivedTasksDeleteUndo(input: UndoEnvelope): Promise<NativeHostResult<NativeArchivedTasksDeleteUndoResult>> {
            const envelope = readUndo(input, source); return envelope ? commit<NativeArchivedTasksDeleteUndoResult>(envelope) : fail('INVALID_INPUT', 'Prepared Archive Undo is malformed');
        },
    };
}

/** Preserve all legacy entry points and their exact source/envelope grammar. */
export function createArchivedTasksDeleteMethods(deps: Parameters<typeof createTasksDeleteMethods>[0]) {
    const methods = createTasksDeleteMethods(deps, 'legacy');
    return {
        prepareArchivedTasksDelete: (input: NativeArchivedTasksDeleteRequest) => methods.prepareArchivedTasksDelete(input) as Promise<NativeHostResult<NativeArchivedTasksDeletePreparation>>,
        validatePreparedArchivedTasksDelete: (input: NativeArchivedTasksDeleteEnvelope) => methods.validatePreparedArchivedTasksDelete(input),
        archivedTasksDeleteOutcome: (input: NativeArchivedTasksDeleteEnvelope) => methods.archivedTasksDeleteOutcome(input),
        commitPreparedArchivedTasksDelete: (input: NativeArchivedTasksDeleteEnvelope) => methods.commitPreparedArchivedTasksDelete(input),
        prepareArchivedTasksDeleteUndo: (input: NativeArchivedTasksDeleteUndoPrepareRequest) => methods.prepareArchivedTasksDeleteUndo(input) as Promise<NativeHostResult<NativeArchivedTasksDeleteUndoPreparation>>,
        validatePreparedArchivedTasksDeleteUndo: (input: NativeArchivedTasksDeleteUndoEnvelope) => methods.validatePreparedArchivedTasksDeleteUndo(input),
        archivedTasksDeleteUndoOutcome: (input: NativeArchivedTasksDeleteUndoEnvelope) => methods.archivedTasksDeleteUndoOutcome(input),
        commitPreparedArchivedTasksDeleteUndo: (input: NativeArchivedTasksDeleteUndoEnvelope) => methods.commitPreparedArchivedTasksDeleteUndo(input),
    };
}
