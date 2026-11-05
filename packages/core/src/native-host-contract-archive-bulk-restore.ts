import type { NativeHostResult } from './native-host-contract';
import type { AppData, Area, Project, Section, Task, TaskStatus } from './types';
import type { PreparedAreaAuthority, PreparedNativeSaveBoundary } from './store-types';
import { exact, iso, record, validProject } from './native-host-contract-project-shared';
import { validSection } from './native-host-contract-project-section-rename';
import { validRawTask } from './native-host-contract-task-save';
import { validFrozenFocusDate } from './native-host-contract-task-focus';
import { historyRowLoadProjection } from './native-host-contract-task-checklist';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { createAreaSaveGuard, readAreaDurableData } from './native-host-contract-area-durable';
import { createNativeRequestReceipts, taskRevisionOf } from './native-request-receipts';
import { taskEditValuesEqual } from './json-value-equality';
import { buildEntityMap, ensureDeviceId } from './store-helpers';
import { planTaskBatchUpdateEffects, prepareTaskBatchUpdatesForStore } from './store-tasks';
import { getStorageAdapter, useTaskStore } from './store';
import { normalizeProjectLifecycleFields } from './project-status';
import { isProjectedRecurringTaskId } from './recurrence';
import { projectFocusDateValues, type FocusDateProjection } from './task-utils';
import { logInfo } from './logger';
import { getBulkMoveStatusOptions } from './task-list-bulk-actions';
import { isStatusListTaskReadOnly } from './menu-views-model';
import { buildBulkTaskTokenUpdates } from './bulk-task-tokens';

export type NativeArchivedTasksRestoreRequest = {
    requestId: string; taskIds: string[]; taskRevisions: Record<string, string>;
} & ({ source?: never; status?: never; action?: never; tag?: never; tags?: never }
    | { source: 'done'; status: Exclude<TaskStatus, 'done'>; action?: never; tag?: never; tags?: never }
    | { source: 'done'; action: 'addTag'; tag: string; status?: never; tags?: never }
    | { source: 'done'; action: 'removeTag'; tags: string[]; status?: never; tag?: never });
type AddTagRequest = Extract<NativeArchivedTasksRestoreRequest, { action: 'addTag' }>;
type RemoveTagRequest = Extract<NativeArchivedTasksRestoreRequest, { action: 'removeTag' }>;
type TagEditRequest = AddTagRequest | RemoveTagRequest;
export type NativeArchivedTasksRestoreResult = { count: number; status: Exclude<TaskStatus, 'done'> }
    | { count: number; changed: true };
export type NativeArchivedTasksRestoreScope = {
    tasks: Task[]; projects: Project[]; sections: Section[]; areas: Area[]; settings: AppData['settings'];
};
export type NativePreparedArchivedTasksRestore = {
    version: 1;
    request: NativeArchivedTasksRestoreRequest;
    scope: NativeArchivedTasksRestoreScope;
    effect: { tasks: { before: Task; after: Task }[]; projects: { before: Project; after: Project }[];
        sections: { before: Section; after: Section }[] };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
    preparedLocalDay: string;
    preparedOffsetMinutes: number;
    boundaryOffsetMinutes: number;
    futureBoundary: string;
    dates: FocusDateProjection[];
    result: NativeArchivedTasksRestoreResult;
};
export type NativeArchivedTasksRestoreEnvelope = { request: NativeArchivedTasksRestoreRequest;
    prepared: NativePreparedArchivedTasksRestore };
export type NativeArchivedTasksRestorePreparation = { kind: 'prepared'; prepared: NativePreparedArchivedTasksRestore }
    | { kind: 'noop'; result: { count: 0; changed: false } };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const same = taskEditValuesEqual;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'TASK_NOT_FOUND' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const text = (value: unknown, limit: number): value is string =>
    typeof value === 'string' && Boolean(value.trim()) && value.length <= limit;
const unique = (rows: { id: string }[]) => new Set(rows.map((row) => row.id)).size === rows.length;
const canonicalPayload = (value: unknown): string => JSON.stringify(value, (_name, item) => record(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);


const detach = <T>(value: unknown): T | null => {
    const valid = (item: unknown, depth: number, path: string): boolean => {
        if (depth > 24) return false;
        if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
        if (typeof item === 'number') return Number.isFinite(item);
        if (Array.isArray(item)) return item.length <= 100_000 && item.every((part) => valid(part, depth + 1, `${path}[]`));
        const revisions = path === 'taskRevisions' || path === 'request.taskRevisions' || path === 'prepared.request.taskRevisions';
        return record(item) && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)
            && Object.keys(item).length <= (revisions ? 10_000 : 128)
            && Object.entries(item).every(([name, part]) => !['__proto__', 'constructor', 'prototype'].includes(name)
                && valid(part, depth + 1, path ? `${path}.${name}` : name));
    };
    if (!isNativeJsonWithinBytes(value) || !valid(value, 0, '')) return null;
    return JSON.parse(JSON.stringify(value)) as T;
};
const jsonSafe = <T>(value: unknown): T | null => {
    try { return detach<T>(JSON.parse(JSON.stringify(value))); } catch { return null; }
};
const readRequest = (input: unknown): NativeArchivedTasksRestoreRequest | null => {
    const request = detach<Record<string, unknown>>(input);
    const addTag = request?.source === 'done' && request.action === 'addTag';
    const removeTag = request?.source === 'done' && request.action === 'removeTag';
    if (!request || !exact(request, addTag ? ['requestId', 'taskIds', 'taskRevisions', 'source', 'action', 'tag']
        : removeTag ? ['requestId', 'taskIds', 'taskRevisions', 'source', 'action', 'tags']
        : request.source === 'done' ? ['requestId', 'taskIds', 'taskRevisions', 'source', 'status'] : ['requestId', 'taskIds', 'taskRevisions'])
        || (addTag ? !text(request.tag, 2000)
            : removeTag ? !Array.isArray(request.tags) || request.tags.length === 0 || request.tags.length > 10_000
                || !request.tags.every((tag) => text(tag, 2_000_000)) || new Set(request.tags).size !== request.tags.length
            : request.source === 'done' && !getBulkMoveStatusOptions('done').includes(request.status as TaskStatus))
        || typeof request.requestId !== 'string' || !UUID.test(request.requestId)
        || !Array.isArray(request.taskIds) || request.taskIds.length === 0 || request.taskIds.length > 10_000
        || !request.taskIds.every((id) => text(id, 500)) || new Set(request.taskIds).size !== request.taskIds.length
        || !record(request.taskRevisions) || !exact(request.taskRevisions, request.taskIds)
        || !Object.values(request.taskRevisions).every((revision) => text(revision, 200))) return null;
    return request as NativeArchivedTasksRestoreRequest;
};
const isAddTag = (request: NativeArchivedTasksRestoreRequest): request is AddTagRequest => request.source === 'done' && request.action === 'addTag';
const isRemoveTag = (request: NativeArchivedTasksRestoreRequest): request is RemoveTagRequest => request.source === 'done' && request.action === 'removeTag';
const isTagEdit = (request: NativeArchivedTasksRestoreRequest): request is TagEditRequest => isAddTag(request) || isRemoveTag(request);
const targetStatus = (request: Exclude<NativeArchivedTasksRestoreRequest, TagEditRequest>): Exclude<TaskStatus, 'done'> => request.source === 'done' ? request.status : 'inbox';
const requestUpdates = (request: NativeArchivedTasksRestoreRequest, tasks: Task[]) => isAddTag(request)
    ? buildBulkTaskTokenUpdates(request.taskIds, buildEntityMap(tasks), 'tags', request.tag, 'add')
    : isRemoveTag(request) ? buildBulkTaskTokenUpdates(request.taskIds, buildEntityMap(tasks), 'tags', request.tags, 'remove')
    : request.taskIds.map((id) => ({ id, updates: { status: targetStatus(request) } }));
const sourceName = (request: unknown): 'Done' | 'Archive' => record(request) && request.source === 'done' ? 'Done' : 'Archive';
const actionName = (request: unknown): string => sourceName(request) === 'Done'
    ? record(request) && request.action === 'addTag' ? 'Done Add tag'
        : record(request) && request.action === 'removeTag' ? 'Done Remove tag' : 'Done Move' : 'Archive Restore';
const validTask = (row: unknown): row is Task => record(row) && text(row.id, 500) && validRawTask(row, row.id);
const validArea = (row: unknown): row is Area => record(row) && text(row.id, 500)
    && typeof row.name === 'string' && iso(row.createdAt) && iso(row.updatedAt)
    && (row.deletedAt === undefined || iso(row.deletedAt));


export const archivedTasksRestoreScope = (request: NativeArchivedTasksRestoreRequest,
    data: Pick<AppData, 'tasks' | 'projects' | 'sections' | 'areas' | 'settings'>): NativeArchivedTasksRestoreScope => {
    const selected = new Set(request.taskIds);
    const selectedTasks = data.tasks.filter((row) => selected.has(row.id));
    const sectionsById = buildEntityMap(data.sections);
    const selectedSections = new Set(selectedTasks.flatMap((row) => row.sectionId ? [row.sectionId] : []));
    const parentIds = new Set(selectedTasks.flatMap((row) => {
        const inferred = row.sectionId ? sectionsById.get(row.sectionId)?.projectId : undefined;
        return [...(row.projectId ? [row.projectId] : []), ...(inferred ? [inferred] : [])];
    }));
    const projects = data.projects.filter((row) => parentIds.has(row.id));
    const areaIds = new Set([...selectedTasks, ...projects].flatMap((row) => row.areaId ? [row.areaId] : []));
    return {
        tasks: data.tasks.filter((row) => selected.has(row.id) || Boolean(row.projectId && parentIds.has(row.projectId))
            || Boolean(!row.projectId && row.sectionId && parentIds.has(sectionsById.get(row.sectionId)?.projectId ?? ''))),
        projects,
        sections: data.sections.filter((row) => parentIds.has(row.projectId) || selectedSections.has(row.id)),
        areas: data.areas.filter((row) => areaIds.has(row.id)),
        settings: data.settings,
    };
};
const requiredDates = (scope: NativeArchivedTasksRestoreScope): string[] => [...new Set(scope.tasks.flatMap((row) =>
    [row.startTime, row.dueDate, row.reviewAt].filter((part): part is string => typeof part === 'string')))].sort();
const selectedSourcesMatch = (request: NativeArchivedTasksRestoreRequest, scope: NativeArchivedTasksRestoreScope): boolean => {
    const byId = buildEntityMap(scope.tasks);
    return request.taskIds.every((id) => {
        const row = byId.get(id);
        return row && row.status === (request.source === 'done' ? 'done' : 'archived') && !row.deletedAt && !row.purgedAt
            && !isProjectedRecurringTaskId(id) && taskRevisionOf(row) === request.taskRevisions[id]
            && (request.source !== 'done' || !isStatusListTaskReadOnly(row, scope.projects));
    });
};


export const archivedTasksRestoreEffect = (prepared: Pick<NativePreparedArchivedTasksRestore,
    'request' | 'scope' | 'deviceIdBefore' | 'deviceIdToInitialize' | 'updateAt' | 'futureBoundary' | 'dates'>)
    : NativePreparedArchivedTasksRestore['effect'] | null => {
    const { request, scope } = prepared;
    const tasks = scope.tasks.map((row) => historyRowLoadProjection(row, prepared.updateAt));
    const projects = scope.projects.map(normalizeProjectLifecycleFields);
    const preflight = prepareTaskBatchUpdatesForStore({
        updatesList: requestUpdates(request, tasks),
        state: { _tasksById: buildEntityMap(tasks), _projectsById: buildEntityMap(projects),
            _allProjects: projects, _allSections: scope.sections, _allAreas: scope.areas,
            settings: scope.settings, persistenceFailure: null },
        futureBoundary: prepared.futureBoundary, futureDates: new Map(prepared.dates.map((row) => [row.value, row])),
        nowMs: Date.parse(prepared.updateAt),
    });
    if (!preflight.ok || preflight.optimisticRetryProjectIds.length) return null;
    const planned = planTaskBatchUpdateEffects({
        preparedUpdatesById: preflight.preparedUpdatesById, allTasks: tasks, allProjects: projects,
        allSections: scope.sections, now: prepared.updateAt,
        deviceId: prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!,
    });
    if (planned.createdTasks.length || planned.tasks.length !== tasks.length) return null;
    const pairs = <T extends { id: string }>(raw: T[], loaded: T[], after: T[]): { before: T; after: T }[] => {
        const loadedById = buildEntityMap(loaded);
        const afterById = buildEntityMap(after);
        return raw.flatMap((before) => {
            const result = afterById.get(before.id)!;
            return same(loadedById.get(before.id), result) ? [] : [{ before, after: result }];
        });
    };
    return { tasks: pairs(scope.tasks, tasks, planned.tasks), projects: pairs(scope.projects, projects, planned.projects),
        sections: pairs(scope.sections, scope.sections, planned.sections) };
};

const readEnvelope = (input: unknown): NativeArchivedTasksRestoreEnvelope | null => {
    const envelope = detach<Record<string, unknown>>(input);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'scope', 'effect', 'deviceIdBefore', 'deviceIdToInitialize',
        'updateAt', 'preparedLocalDay', 'preparedOffsetMinutes', 'boundaryOffsetMinutes', 'futureBoundary', 'dates', 'result'])
        || raw.version !== 1 || !same(raw.request, request)
        || !record(raw.scope) || !exact(raw.scope, ['tasks', 'projects', 'sections', 'areas', 'settings'])
        || !Array.isArray(raw.scope.tasks) || !raw.scope.tasks.every(validTask) || !unique(raw.scope.tasks)
        || !Array.isArray(raw.scope.projects) || !raw.scope.projects.every((row) => record(row) && text(row.id, 500) && validProject(row, row.id)) || !unique(raw.scope.projects)
        || !Array.isArray(raw.scope.sections) || !raw.scope.sections.every((row) => record(row) && text(row.id, 500)
            && text(row.projectId, 500) && validSection(row, row.id, row.projectId)) || !unique(raw.scope.sections)
        || !Array.isArray(raw.scope.areas) || !raw.scope.areas.every(validArea) || !unique(raw.scope.areas) || !record(raw.scope.settings)
        || !record(raw.effect) || !exact(raw.effect, ['tasks', 'projects', 'sections'])
        || !Array.isArray(raw.effect.tasks) || !Array.isArray(raw.effect.projects) || !Array.isArray(raw.effect.sections)
        || (raw.deviceIdBefore !== null && !text(raw.deviceIdBefore, 500))
        || (raw.deviceIdBefore === null ? typeof raw.deviceIdToInitialize !== 'string' || !UUID.test(raw.deviceIdToInitialize) : raw.deviceIdToInitialize !== null)
        || !iso(raw.updateAt) || !iso(raw.futureBoundary)
        || typeof raw.preparedLocalDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.preparedLocalDay)
        || !Number.isInteger(raw.preparedOffsetMinutes) || Math.abs(raw.preparedOffsetMinutes as number) > 840
        || !Number.isInteger(raw.boundaryOffsetMinutes) || Math.abs(raw.boundaryOffsetMinutes as number) > 840
        || !Array.isArray(raw.dates) || !raw.dates.every(validFrozenFocusDate)
        || !record(raw.result) || (isTagEdit(request)
            ? !exact(raw.result, ['count', 'changed']) || raw.result.changed !== true
                || !Number.isInteger(raw.result.count) || (raw.result.count as number) < 1 || (raw.result.count as number) > request.taskIds.length
            : !exact(raw.result, ['count', 'status']) || raw.result.count !== request.taskIds.length || raw.result.status !== targetStatus(request))) return null;
    try {
        const prepared = raw as unknown as NativePreparedArchivedTasksRestore;
        if (!selectedSourcesMatch(request, prepared.scope)
            || (prepared.scope.settings.deviceId ?? null) !== prepared.deviceIdBefore
            || !same(archivedTasksRestoreScope(request, prepared.scope), prepared.scope)
            || new Date(Date.parse(prepared.updateAt) - prepared.preparedOffsetMinutes * 60_000).toISOString().slice(0, 10) !== prepared.preparedLocalDay
            || new Date(Date.parse(`${prepared.preparedLocalDay}T23:59:59.999Z`) + prepared.boundaryOffsetMinutes * 60_000).toISOString() !== prepared.futureBoundary
            || !same(requiredDates(prepared.scope), prepared.dates.map((row) => row.value))) return null;
        const expected = archivedTasksRestoreEffect(prepared);
        const changedIds = isTagEdit(request) ? new Set(requestUpdates(request, prepared.scope.tasks.map((row) => historyRowLoadProjection(row, prepared.updateAt))).map((row) => row.id)) : null;
        const selectedIds = new Set(request.taskIds);
        const selectedPairs = expected?.tasks.filter((pair) => selectedIds.has(pair.before.id)) ?? [];
        const restoredIds = isTagEdit(request) ? null : new Set(selectedPairs.filter((pair) => pair.after.status === targetStatus(request)).map((pair) => pair.before.id));
        if (!expected || !same(expected, prepared.effect)
            || (isTagEdit(request)
                ? prepared.result.count !== changedIds!.size || selectedPairs.length !== changedIds!.size
                    || selectedPairs.some((pair) => !changedIds!.has(pair.before.id) || pair.after.status !== 'done')
                : !request.taskIds.every((id) => restoredIds!.has(id)))
            || [...prepared.effect.tasks, ...prepared.effect.projects, ...prepared.effect.sections].some((pair) =>
                !record(pair) || !exact(pair, ['before', 'after']))) return null;
        return envelope as NativeArchivedTasksRestoreEnvelope;
    } catch { return null; }
};

export function createArchivedTasksRestoreMethods(deps: {
    readiness: () => NativeHostResult<null>; save: () => Promise<NativeHostResult<null>>;
}) {
    const saves = createAreaSaveGuard(deps.save);
    let pending: { envelope: NativeArchivedTasksRestoreEnvelope; adapter: ReturnType<typeof getStorageAdapter>;
        boundary: PreparedNativeSaveBoundary | undefined } | null = null;
    const payload = (envelope: NativeArchivedTasksRestoreEnvelope) => canonicalPayload([
        isRemoveTag(envelope.request) ? 'doneTasksRemoveTag' : isAddTag(envelope.request) ? 'doneTasksAddTag'
            : envelope.request.source === 'done' ? 'doneTasksMove' : 'archivedTasksRestore', envelope]);
    const checkAuthority = (envelope: NativeArchivedTasksRestoreEnvelope, authority: PreparedAreaAuthority): NativeHostResult<null> => {
        const prepared = envelope.prepared;
        const current = archivedTasksRestoreScope(envelope.request, authority.snapshot);
        if (!same({ ...current, settings: prepared.scope.settings }, prepared.scope)
            || !selectedSourcesMatch(envelope.request, current)
            || (current.settings.deviceId ?? null) !== prepared.deviceIdBefore)
            return fail('STALE_REVISION', `${sourceName(envelope.request)} selection or its saved parent context changed`);
        try {
            return same(archivedTasksRestoreEffect({ ...prepared, scope: current }), prepared.effect)
                ? { ok: true, value: null } : fail('STALE_REVISION', `${actionName(envelope.request)} rules changed since preparation`);
        } catch { return fail('STALE_REVISION', `${actionName(envelope.request)} destination changed since preparation`); }
    };
    const apply = (envelope: NativeArchivedTasksRestoreEnvelope, authority: PreparedAreaAuthority) =>
        useTaskStore.getState().commitPreparedArchivedTasksRestore(envelope.prepared, authority);
    const receipts = createNativeRequestReceipts({ save: async (requestId) => {
        const owned = pending;
        if (!owned || owned.envelope.request.requestId !== requestId) return fail('SAVE_FAILED', `${actionName(owned?.envelope.request)} has no owned raw save`);
        if (useTaskStore.getState().persistenceFailure) {
            if (!saves.mayApply(owned.envelope, owned.adapter)) return fail('SAVE_FAILED', `${actionName(owned.envelope.request)} has an unrelated persistence failure`);
            const read = await readAreaDurableData(true, true);
            if (!read.ok) return read;
            if (read.value.adapter !== owned.adapter) return fail('STALE_REVISION', `${actionName(owned.envelope.request)} storage changed before retry`);
            const checked = checkAuthority(owned.envelope, read.value.authority);
            if (!checked.ok) return checked;
            const applied = await apply(owned.envelope, read.value.authority);
            if (!applied.success || applied.outcome !== 'applied') return fail('STALE_REVISION', applied.error ?? `${actionName(owned.envelope.request)} retry was superseded`);
            owned.boundary = read.value.authority.saveBoundary;
        }
        const saved = await saves.finish(owned.envelope, owned.adapter, false, owned.boundary);
        if (saved.ok) pending = null;
        return saved;
    } });
    return {
        async prepareArchivedTasksRestore(input: NativeArchivedTasksRestoreRequest): Promise<NativeHostResult<NativeArchivedTasksRestorePreparation>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', `Select saved ${sourceName(input)} tasks with their exact revisions; select fewer tasks if the request is too large`);
            const memory = useTaskStore.getState();
            if (!selectedSourcesMatch(request, { tasks: memory._allTasks, projects: memory._allProjects, sections: [], areas: [], settings: memory.settings }))
                return fail('STALE_REVISION', `${sourceName(request)} selection changed since it was shown`);
            const read = await readAreaDurableData(false, true); if (!read.ok) return read;
            const scope = archivedTasksRestoreScope(request, read.value.authority.snapshot);
            if (!selectedSourcesMatch(request, scope)) return fail('STALE_REVISION', `Saved ${sourceName(request)} selection changed`);
            const now = new Date(); const end = new Date(now); end.setHours(23, 59, 59, 999);
            const count = isTagEdit(request) ? requestUpdates(request, scope.tasks.map((row) => historyRowLoadProjection(row, now.toISOString()))).length : request.taskIds.length;
            if (isTagEdit(request) && count === 0) return { ok: true, value: { kind: 'noop', result: { count: 0, changed: false } } };
            const device = ensureDeviceId(scope.settings);
            const base = { version: 1 as const, request, scope, deviceIdBefore: scope.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null, updateAt: now.toISOString(),
                preparedLocalDay: new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10),
                preparedOffsetMinutes: now.getTimezoneOffset(), boundaryOffsetMinutes: end.getTimezoneOffset(),
                futureBoundary: end.toISOString(), dates: projectFocusDateValues(requiredDates(scope)),
                result: isTagEdit(request) ? { count, changed: true as const } : { count, status: targetStatus(request) } };
            let effect;
            try { effect = archivedTasksRestoreEffect(base); } catch { effect = null; }
            const prepared = effect && jsonSafe<NativePreparedArchivedTasksRestore>({ ...base, effect });
            return prepared && readEnvelope({ request, prepared }) ? { ok: true, value: { kind: 'prepared', prepared } }
                : fail('INVALID_INPUT', `${actionName(request)} cannot prepare these rows or its journal is too large; select fewer tasks`);
        },
        validatePreparedArchivedTasksRestore(input: NativeArchivedTasksRestoreEnvelope): NativeHostResult<NativeArchivedTasksRestoreResult> {
            const envelope = readEnvelope(input);
            return envelope ? { ok: true, value: envelope.prepared.result } : fail('INVALID_INPUT', `Prepared ${actionName(record(input) ? input.request : null)} is malformed`);
        },
        archivedTasksRestoreOutcome(input: NativeArchivedTasksRestoreEnvelope): NativeHostResult<NativeArchivedTasksRestoreResult | null> {
            const envelope = readEnvelope(input);
            if (!envelope) return fail('INVALID_INPUT', `Prepared ${actionName(record(input) ? input.request : null)} is malformed`);
            return receipts.saved<NativeArchivedTasksRestoreResult>(envelope.request.requestId, payload(envelope)) ?? { ok: true, value: null };
        },
        async commitPreparedArchivedTasksRestore(input: NativeArchivedTasksRestoreEnvelope): Promise<NativeHostResult<NativeArchivedTasksRestoreResult>> {
            const envelope = readEnvelope(input);
            if (!envelope) return fail('INVALID_INPUT', `Prepared ${actionName(record(input) ? input.request : null)} is malformed`);
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const boundPayload = payload(envelope);
            const saved = receipts.saved<NativeArchivedTasksRestoreResult>(envelope.request.requestId, boundPayload);
            if (saved) return saved.ok && !same(saved.value, envelope.prepared.result)
                ? fail('INVALID_INPUT', `Saved ${actionName(envelope.request)} result does not match its journal`) : saved;
            let prewriteFailure: NativeHostResult<never> | null = null;
            const notLanded = (message: string): NativeHostResult<never> => {
                prewriteFailure = fail('SAVE_FAILED', message);
                return { ok: false, error: { code: 'ACTION_FAILED', message } };
            };
            const confirmed = await receipts.run(envelope.request.requestId, boundPayload, async () => {
                if (useTaskStore.getState().persistenceFailure) return notLanded(`${actionName(envelope.request)} has an unresolved persistence failure`);
                const read = await readAreaDurableData(false, true);
                if (!read.ok) return read.error.code === 'SAVE_FAILED' ? notLanded(read.error.message) : read;
                const checked = checkAuthority(envelope, read.value.authority); if (!checked.ok) return checked;
                const applied = await apply(envelope, read.value.authority);
                if (!applied.success || applied.outcome !== 'applied') return fail('STALE_REVISION', applied.error ?? `${actionName(envelope.request)} conflicts with saved data`);
                pending = { envelope, adapter: read.value.adapter, boundary: read.value.authority.saveBoundary };
                return { ok: true, value: envelope.prepared.result };
            });
            if (prewriteFailure) return prewriteFailure;
            if (confirmed.ok && !same(confirmed.value, envelope.prepared.result)) return fail('INVALID_INPUT', `Saved ${actionName(envelope.request)} result does not match its journal`);
            if (confirmed.ok) {
                try { logInfo(isRemoveTag(envelope.request) ? 'Native Done bulk tag removal confirmed' : isAddTag(envelope.request) ? 'Native Done bulk tag confirmed' : envelope.request.source === 'done' ? 'Native Done bulk status confirmed' : 'Native Archive bulk Restore confirmed', { scope: 'native-host', category: 'storage',
                    context: { releaseCheck: isRemoveTag(envelope.request) ? 'v1.3.4/ios-done-bulk-tag-remove' : isAddTag(envelope.request) ? 'v1.3.4/ios-done-bulk-tag' : envelope.request.source === 'done' ? 'v1.3.4/ios-done-bulk-status' : 'v1.3.4/ios-archive-bulk-restore',
                        outcome: isRemoveTag(envelope.request) ? 'removed' : isAddTag(envelope.request) ? 'added' : envelope.request.source === 'done' ? 'moved' : 'confirmed' } }); }
                catch {                                                               }
            }
            return confirmed;
        },
    };
}
