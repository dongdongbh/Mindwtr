import type { NativeHostResult } from './native-host-contract';
import type { AppData, Area, Project, Section, Task } from './types';
import type { PreparedAreaAuthority, PreparedNativeSaveBoundary } from './store-types';
import { exact, iso, record, validProject } from './native-host-contract-project-shared';
import { validSection } from './native-host-contract-project-section-rename';
import { validRawTask } from './native-host-contract-task-save';
import { historyRowLoadProjection } from './native-host-contract-task-checklist';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { createAreaSaveGuard, readAreaDurableData } from './native-host-contract-area-durable';
import { createNativeRequestReceipts, NativeReceiptSqliteAdapter, taskRevisionOf } from './native-request-receipts';
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

export type NativeArchivedTasksDeleteRequest = { requestId: string; taskIds: string[]; taskRevisions: Record<string, string>; source?: 'done' | 'reference' | 'inbox' };
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
type MutationEnvelope = NativeArchivedTasksDeleteEnvelope | NativeArchivedTasksDeleteUndoEnvelope;
type MutationResult = NativeArchivedTasksDeleteResult | NativeArchivedTasksDeleteUndoResult;

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const same = taskEditValuesEqual;
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= limit;
const notice = (value: unknown, limit: number): value is string => text(value, limit) && Array.from(value).every((part) => part.charCodeAt(0) >= 32 && part.charCodeAt(0) !== 127);
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> => ({ ok: false, error: { code, message } });
const unique = (rows: { id: string }[]) => new Set(rows.map((row) => row.id)).size === rows.length;
const canonicalPayload = (value: unknown): string => JSON.stringify(value, (_name, item) => record(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
// Only the known Delete request paths can carry the selection-sized revision dictionary.
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
const readDeleteRequest = (input: unknown): NativeArchivedTasksDeleteRequest | null => {
    const request = detach<Record<string, unknown>>(input);
    if (!request || !exact(request, request.source === 'done' || request.source === 'reference' || request.source === 'inbox' ? ['requestId', 'taskIds', 'taskRevisions', 'source'] : ['requestId', 'taskIds', 'taskRevisions'])
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
const usesRawSnapshots = (source: NativeArchivedTasksDeleteRequest['source']): boolean => source === 'reference' || source === 'inbox';
const unreadableRaw = (source: string): NativeHostResult<never> => fail('SAVE_FAILED', `Saved ${source} raw JSON could not be bound safely`);
const deleteProjects = (tasks: readonly Task[], projects: readonly Project[]): Project[] => {
    const ids = new Set(tasks.flatMap((row) => row.projectId ? [row.projectId] : []));
    return projects.filter((row) => ids.has(row.id));
};
const selectedSourcesMatch = (request: NativeArchivedTasksDeleteRequest, tasks: Task[], projects: readonly Project[] = []): boolean => {
    if (tasks.length !== request.taskIds.length || !unique(tasks)) return false;
    const byId = buildEntityMap(tasks); const projectById = buildEntityMap(projects);
    return request.taskIds.every((id) => { const row = byId.get(id); return row && row.status === (request.source ?? 'archived')
        && !row.deletedAt && !row.purgedAt && !isProjectedRecurringTaskId(id) && taskRevisionOf(row) === request.taskRevisions[id]
        && (!request.source || !isStatusListTaskReadOnly(row, projects))
        && (request.source !== 'inbox' || isTaskVisibleInInbox(row, { projectById })); });
};
const deleteAfter = (prepared: Pick<NativePreparedArchivedTasksDelete, 'before' | 'updateAt' | 'deviceIdBefore' | 'deviceIdToInitialize'>): Task[] =>
    planTaskMutations({ tasks: prepared.before.map((row) => historyRowLoadProjection(row, prepared.updateAt)), state: {},
        buildUpdates: (_task, { now }) => ({ deletedAt: now }), now: prepared.updateAt,
        deviceId: prepared.deviceIdBefore ?? prepared.deviceIdToInitialize! });

/** Only references consumed by the existing restore sanitizer, in saved order. */
export const archivedTasksDeleteUndoScope = (tasks: readonly Task[], data: Pick<AppData, 'projects' | 'sections' | 'areas'>): NativeArchivedTasksDeleteUndoScope => {
    const sectionIds = new Set(tasks.flatMap((row) => row.sectionId ? [row.sectionId.trim()] : []));
    const sections = data.sections.filter((row) => sectionIds.has(row.id));
    const projectIds = new Set([...tasks.flatMap((row) => row.projectId ? [row.projectId.trim()] : []), ...sections.map((row) => row.projectId)]);
    const areaIds = new Set(tasks.flatMap((row) => row.areaId ? [row.areaId.trim()] : []));
    return { projects: data.projects.filter((row) => projectIds.has(row.id)), sections,
        areas: data.areas.filter((row) => areaIds.has(row.id)) };
};
const undoAfter = (prepared: Pick<NativePreparedArchivedTasksDeleteUndo, 'before' | 'scope' | 'updateAt' | 'deviceIdBefore' | 'deviceIdToInitialize'>): Task[] =>
    planTaskMutations({ tasks: prepared.before.map((row) => historyRowLoadProjection(row, prepared.updateAt)),
        state: { _allProjects: prepared.scope.projects, _allSections: prepared.scope.sections, _allAreas: prepared.scope.areas },
        buildUpdates: (task, { state }) => ({ deletedAt: undefined, ...sanitizeRestoredTaskContainerReferences(task, state) }),
        now: prepared.updateAt, deviceId: prepared.deviceIdBefore ?? prepared.deviceIdToInitialize! });
const validArea = (row: unknown): row is Area => record(row) && text(row.id, 500) && typeof row.name === 'string'
    && iso(row.createdAt) && iso(row.updatedAt) && (row.deletedAt === undefined || iso(row.deletedAt));
const validContextProject = (row: unknown): row is Project => record(row) && text(row.id, 500)
    && (row.deletedAt === undefined || iso(row.deletedAt)) && (row.purgedAt === undefined || iso(row.purgedAt))
    && validProject({ ...row, deletedAt: undefined, purgedAt: undefined }, row.id);
// Validate known legacy codec defaults without changing the raw guarded snapshot.
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
const readDelete = (input: unknown): NativeArchivedTasksDeleteEnvelope | null => {
    const envelope = detach<Record<string, unknown>>(input);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readDeleteRequest(envelope.request); const raw = envelope.prepared;
    const keys = ['version', 'request', 'before', 'after', 'deviceIdBefore', 'deviceIdToInitialize', 'updateAt', 'result'];
    if (request?.source) keys.push('projects');
    if (!request || !exact(raw, keys)
        || raw.version !== 1 || !same(raw.request, request) || !validDevice(raw)
        || !Array.isArray(raw.before) || !raw.before.every(usesRawSnapshots(request.source) ? validReferenceTask : validTask)
        || (request.source && (!Array.isArray(raw.projects) || !unique(raw.projects) || !raw.projects.every(usesRawSnapshots(request.source) ? validReferenceContextProject : validContextProject)
            || !same(deleteProjects(raw.before, raw.projects), raw.projects)))
        || !selectedSourcesMatch(request, raw.before, request.source ? raw.projects as Project[] : [])
        || !Array.isArray(raw.after) || !raw.after.every(validTask) || !record(raw.result) || !exact(raw.result, ['count', 'deletion'])
        || raw.result.count !== request.taskIds.length || !record(raw.result.deletion) || !exact(raw.result.deletion, ['message', 'undoLabel', 'undoEnabled'])
        || !notice(raw.result.deletion.message, 512) || !notice(raw.result.deletion.undoLabel, 80) || raw.result.deletion.undoEnabled !== true) return null;
    try { const prepared = raw as unknown as NativePreparedArchivedTasksDelete;
        return same(deleteAfter(prepared), prepared.after) ? envelope as unknown as NativeArchivedTasksDeleteEnvelope : null;
    } catch { return null; }
};
const readUndo = (input: unknown): NativeArchivedTasksDeleteUndoEnvelope | null => {
    const envelope = detach<Record<string, unknown>>(input);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readUndoRequest(envelope.request); const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'delete', 'before', 'after', 'scope', 'deviceIdBefore', 'deviceIdToInitialize', 'updateAt', 'result'])
        || raw.version !== 1 || !same(raw.request, request) || !validDevice(raw)
        || !Array.isArray(raw.before) || !raw.before.every(validTask) || !Array.isArray(raw.after) || !raw.after.every(validTask)
        || !record(raw.result) || !exact(raw.result, ['count'])) return null;
    const deletion = readDelete(raw.delete);
    if (!deletion || !validScope(raw.scope, usesRawSnapshots(deletion.request.source)) || deletion.request.requestId !== request.deleteRequestId || !same(raw.before, deletion.prepared.after)
        || raw.result.count !== deletion.prepared.result.count) return null;
    try { const prepared = raw as unknown as NativePreparedArchivedTasksDeleteUndo;
        return same(archivedTasksDeleteUndoScope(prepared.before, prepared.scope), prepared.scope) && same(undoAfter(prepared), prepared.after)
            ? envelope as unknown as NativeArchivedTasksDeleteUndoEnvelope : null;
    } catch { return null; }
};
const isUndo = (envelope: MutationEnvelope): envelope is NativeArchivedTasksDeleteUndoEnvelope => 'delete' in envelope.prepared;
const isDone = (envelope: MutationEnvelope): boolean => (isUndo(envelope) ? envelope.prepared.delete.request : envelope.request).source === 'done';
const isReference = (envelope: MutationEnvelope): boolean => (isUndo(envelope) ? envelope.prepared.delete.request : envelope.request).source === 'reference';
const isInbox = (envelope: MutationEnvelope): boolean => (isUndo(envelope) ? envelope.prepared.delete.request : envelope.request).source === 'inbox';
const requiresRawSnapshots = (envelope: MutationEnvelope): boolean => usesRawSnapshots((isUndo(envelope) ? envelope.prepared.delete.request : envelope.request).source);
const sourceName = (envelope: MutationEnvelope): string => isInbox(envelope) ? 'Inbox' : isReference(envelope) ? 'Reference' : isDone(envelope) ? 'Done' : 'Archive';
// Preserve existing Archive wording on Done's legacy raw-safety error branches.
const rawSourceName = (envelope: MutationEnvelope): string => isInbox(envelope) ? 'Inbox' : isReference(envelope) ? 'Reference' : 'Archive';
const requestSourceName = (request: NativeArchivedTasksDeleteRequest): string => request.source === 'inbox' ? 'Inbox' : request.source === 'reference' ? 'Reference' : request.source === 'done' ? 'Done' : 'Archive';
const buildUndo = (request: NativeArchivedTasksDeleteUndoRequest, deletion: NativeArchivedTasksDeleteEnvelope,
    data: Pick<AppData, 'projects' | 'sections' | 'areas' | 'settings'>, updateAt: string): NativeArchivedTasksDeleteUndoEnvelope | null => {
    const scope = undoScope(deletion.prepared.after, data, requiresRawSnapshots(deletion)); if (!scope) return null;
    const device = ensureDeviceId(data.settings);
    const base = { version: 1 as const, request, delete: deletion, before: deletion.prepared.after,
        scope, deviceIdBefore: data.settings.deviceId ?? null,
        deviceIdToInitialize: device.updated ? device.deviceId : null, updateAt, result: { count: deletion.prepared.result.count } };
    try { return jsonSafe<NativeArchivedTasksDeleteUndoEnvelope>({ request, prepared: { ...base, after: undoAfter(base) } }); }
    catch { return null; }
};
const prospectiveUndoFits = (deletion: NativeArchivedTasksDeleteEnvelope, data: Pick<AppData, 'projects' | 'sections' | 'areas' | 'settings'>): boolean => {
    const dummy = deletion.request.requestId === '00000000-0000-4000-8000-000000000000'
        ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000000';
    const settings = deletion.prepared.deviceIdToInitialize ? { ...data.settings, deviceId: deletion.prepared.deviceIdToInitialize } : data.settings;
    const undo = buildUndo({ requestId: dummy, deleteRequestId: deletion.request.requestId }, deletion, { ...data, settings }, deletion.prepared.updateAt);
    return Boolean(undo && readUndo(undo));
};

export function createArchivedTasksDeleteMethods(deps: {
    readiness: () => NativeHostResult<null>; save: () => Promise<NativeHostResult<null>>; t: () => (key: string) => string;
}) {
    const saves = createAreaSaveGuard(deps.save);
    let pending: { envelope: MutationEnvelope; adapter: ReturnType<typeof getStorageAdapter>; boundary: PreparedNativeSaveBoundary | undefined } | null = null;
    const payload = (envelope: MutationEnvelope) => canonicalPayload([
        isInbox(envelope) ? (isUndo(envelope) ? 'inboxTasksDeleteUndo' : 'inboxTasksDelete')
            : isReference(envelope) ? (isUndo(envelope) ? 'referenceTasksDeleteUndo' : 'referenceTasksDelete')
            : isDone(envelope) ? (isUndo(envelope) ? 'doneTasksDeleteUndo' : 'doneTasksDelete')
            : (isUndo(envelope) ? 'archivedTasksDeleteUndo' : 'archivedTasksDelete'), envelope]);
    const savedResult = <T extends MutationResult>(envelope: MutationEnvelope): NativeHostResult<T> | null => {
        const saved = receipts.saved<T>(envelope.request.requestId, payload(envelope));
        return saved?.ok && !same(saved.value, envelope.prepared.result) ? fail('INVALID_INPUT', `Saved ${sourceName(envelope)} Trash result does not match its journal`) : saved;
    };
    const requireDeleteReceipt = (deletion: NativeArchivedTasksDeleteEnvelope): NativeHostResult<null> => {
        const saved = savedResult<NativeArchivedTasksDeleteResult>(deletion);
        if (saved && !saved.ok) return saved;
        return saved ? { ok: true, value: null } : fail('STALE_REVISION', `${sourceName(deletion)} Delete is not confirmed; retry its exact request before Undo`);
    };
    const requireDurableDeleteReceipt = async (deletion: NativeArchivedTasksDeleteEnvelope,
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
            if (isDone(envelope) || requiresRawSnapshots(envelope)) {
                const parents = deleteProjects(current, data.projects);
                const projects = requiresRawSnapshots(envelope) ? referenceProjects(parents) : parents;
                if (!projects) return unreadableRaw(sourceName(envelope));
                if (!same(projects, envelope.prepared.projects)) return fail('STALE_REVISION', `${sourceName(envelope)} parent projects changed since preparation`);
            }
            if (!selectedSourcesMatch(envelope.request, current, data.projects)) return fail('STALE_REVISION', `${sourceName(envelope)} selection changed since it was shown`);
            if (requiresRawSnapshots(envelope) && !undoScope(current, data, true)) return unreadableRaw(sourceName(envelope));
            if (!prospectiveUndoFits(envelope, data)) return fail('INVALID_INPUT', `${rawSourceName(envelope)} Undo journal would be too large; select fewer tasks`);
        }
        return { ok: true, value: null };
    };
    const apply = (envelope: MutationEnvelope, authority: PreparedAreaAuthority) => {
        if (requiresRawSnapshots(envelope)) {
            // Only operated rows need the exact JSON member snapshot. Preserve
            // every other raw object and its original SQLite-row provenance.
            const snapshots = referenceRows(selectedRows(envelope.prepared.before.map((row) => row.id), authority.snapshot.tasks));
            if (!snapshots) return Promise.resolve({ success: false as const, reason: 'conflict' as const, error: `Saved ${sourceName(envelope)} raw JSON could not be bound safely` });
            const selected = buildEntityMap(snapshots);
            authority.snapshot = { ...authority.snapshot, tasks: authority.snapshot.tasks.map((row) => selected.get(row.id) ?? row) };
        }
        return useTaskStore.getState().commitPreparedArchivedTasksMutation({
            before: envelope.prepared.before, after: envelope.prepared.after, deviceIdBefore: envelope.prepared.deviceIdBefore,
            deviceIdToInitialize: envelope.prepared.deviceIdToInitialize, operation: isUndo(envelope) ? 'undo' : 'delete' }, authority);
    };
    const receipts = createNativeRequestReceipts({ save: async (requestId) => {
        const owned = pending;
        if (!owned || owned.envelope.request.requestId !== requestId) return fail('SAVE_FAILED', 'Archive Trash has no owned raw save');
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
        if (confirmed.ok) { try { if (isInbox(envelope)) logInfo('Native Inbox bulk Trash confirmed', { scope: 'native-host', category: 'storage',
            context: { releaseCheck: 'v1.3.5/ios-inbox-bulk-trash', count: confirmed.value.count, outcome: isUndo(envelope) ? 'restored' : 'deleted' } });
        else if (isReference(envelope)) logInfo('Native Reference bulk Trash confirmed', { scope: 'native-host', category: 'storage',
            context: { releaseCheck: 'v1.3.4/ios-reference-bulk-trash', count: confirmed.value.count, outcome: isUndo(envelope) ? 'restored' : 'deleted' } });
        else logInfo(`Native ${sourceName(envelope)} bulk Trash confirmed`, { scope: 'native-host', category: 'storage',
            context: { releaseCheck: isDone(envelope) ? 'v1.3.4/ios-done-bulk-trash' : 'v1.3.4/ios-archive-bulk-trash', outcome: isUndo(envelope) ? 'restored' : 'deleted' } }); }
        catch { /* Diagnostics cannot invalidate a durable acknowledgment. */ } }
        return confirmed;
    };
    return {
        async prepareArchivedTasksDelete(input: NativeArchivedTasksDeleteRequest): Promise<NativeHostResult<NativeArchivedTasksDeletePreparation>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const request = readDeleteRequest(input);
            if (!request) return fail('INVALID_INPUT', 'Select saved Archive tasks with exact revisions; select fewer tasks if the request is too large');
            const state = useTaskStore.getState();
            if (!selectedSourcesMatch(request, selectedRows(request.taskIds, state._allTasks), state._allProjects))
                return fail('STALE_REVISION', `${requestSourceName(request)} selection changed since it was shown`);
            const read = await readAreaDurableData(false, true); if (!read.ok) return read;
            const data = read.value.authority.snapshot; const selected = selectedRows(request.taskIds, data.tasks);
            const before = usesRawSnapshots(request.source) ? referenceRows(selected) : selected;
            if (!before) return unreadableRaw(requestSourceName(request));
            const parents = deleteProjects(before, data.projects);
            const projects = usesRawSnapshots(request.source) ? referenceProjects(parents) : parents;
            if (!projects || (usesRawSnapshots(request.source) && !undoScope(before, data, true))) return unreadableRaw(requestSourceName(request));
            if (!selectedSourcesMatch(request, before, data.projects)) return fail('STALE_REVISION', `Saved ${requestSourceName(request)} selection changed`);
            const device = ensureDeviceId(data.settings); const t = deps.t();
            const base = { version: 1 as const, request, before, ...(request.source ? { projects } : {}),
                deviceIdBefore: data.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null, updateAt: new Date().toISOString(),
                result: { count: request.taskIds.length, deletion: { message: formatListItemCount(request.taskIds.length, 'task', t),
                    undoLabel: getTrashUndoLabel(t), undoEnabled: true as const } } };
            let command: NativeArchivedTasksDeleteEnvelope | null;
            try { command = jsonSafe({ request, prepared: { ...base, after: deleteAfter(base) } }); } catch { command = null; }
            return command && readDelete(command) && prospectiveUndoFits(command, data)
                ? { ok: true, value: { kind: 'prepared', prepared: command.prepared } }
                : fail('INVALID_INPUT', `${request.source === 'inbox' ? 'Inbox' : request.source === 'reference' ? 'Reference' : 'Archive'} Delete or Undo journal is too large; select fewer tasks`);
        },
        validatePreparedArchivedTasksDelete(input: NativeArchivedTasksDeleteEnvelope): NativeHostResult<NativeArchivedTasksDeleteResult> {
            const envelope = readDelete(input); return envelope ? { ok: true, value: envelope.prepared.result } : fail('INVALID_INPUT', 'Prepared Archive Delete is malformed');
        },
        archivedTasksDeleteOutcome(input: NativeArchivedTasksDeleteEnvelope): NativeHostResult<NativeArchivedTasksDeleteResult | null> {
            const envelope = readDelete(input); return envelope ? savedResult<NativeArchivedTasksDeleteResult>(envelope) ?? { ok: true, value: null }
                : fail('INVALID_INPUT', 'Prepared Archive Delete is malformed');
        },
        async commitPreparedArchivedTasksDelete(input: NativeArchivedTasksDeleteEnvelope): Promise<NativeHostResult<NativeArchivedTasksDeleteResult>> {
            const envelope = readDelete(input); return envelope ? commit<NativeArchivedTasksDeleteResult>(envelope) : fail('INVALID_INPUT', 'Prepared Archive Delete is malformed');
        },
        async prepareArchivedTasksDeleteUndo(input: NativeArchivedTasksDeleteUndoPrepareRequest): Promise<NativeHostResult<NativeArchivedTasksDeleteUndoPreparation>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const raw = detach<Record<string, unknown>>(input);
            const request = raw && exact(raw, ['request', 'delete']) ? readUndoRequest(raw.request) : null;
            const deletion = raw ? readDelete(raw.delete) : null;
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
            return command && readUndo(command) ? { ok: true, value: { kind: 'prepared', prepared: command.prepared } }
                : fail('INVALID_INPUT', `${rawSourceName(deletion)} Undo journal is too large; select fewer tasks`);
        },
        validatePreparedArchivedTasksDeleteUndo(input: NativeArchivedTasksDeleteUndoEnvelope): NativeHostResult<NativeArchivedTasksDeleteUndoResult> {
            const envelope = readUndo(input); return envelope ? { ok: true, value: envelope.prepared.result } : fail('INVALID_INPUT', 'Prepared Archive Undo is malformed');
        },
        archivedTasksDeleteUndoOutcome(input: NativeArchivedTasksDeleteUndoEnvelope): NativeHostResult<NativeArchivedTasksDeleteUndoResult | null> {
            const envelope = readUndo(input); return envelope ? savedResult<NativeArchivedTasksDeleteUndoResult>(envelope) ?? { ok: true, value: null }
                : fail('INVALID_INPUT', 'Prepared Archive Undo is malformed');
        },
        async commitPreparedArchivedTasksDeleteUndo(input: NativeArchivedTasksDeleteUndoEnvelope): Promise<NativeHostResult<NativeArchivedTasksDeleteUndoResult>> {
            const envelope = readUndo(input); return envelope ? commit<NativeArchivedTasksDeleteUndoResult>(envelope) : fail('INVALID_INPUT', 'Prepared Archive Undo is malformed');
        },
    };
}
