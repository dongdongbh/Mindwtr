import type { NativeHostResult } from './native-host-contract';
import type { AppData, Area, Project, Section, Task } from './types';
import type { PreparedAreaAuthority, PreparedNativeSaveBoundary } from './store-types';
import { exact, iso, record, validProject } from './native-host-contract-project-shared';
import { validSection } from './native-host-contract-project-section-rename';
import { validRawTask } from './native-host-contract-task-save';
import { AREA_SYNC_FIELD_SCHEMA, areaToSqliteRow } from './area-sync-schema';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { createAreaSaveGuard, readAreaDurableData } from './native-host-contract-area-durable';
import { createNativeRequestReceipts, isNativeRequestReceiptDurable, revisionOf, taskRevisionOf } from './native-request-receipts';
import { sameSectionDeleteJson } from './store-projects/section-actions';
import { projectRestoreEffect } from './store-projects/project-actions';
import { buildEntityMap, ensureDeviceId } from './store-helpers';
import { planTaskMutations, sanitizeRestoredTaskContainerReferences } from './store-tasks';
import { getStorageAdapter, useTaskStore } from './store';
import { isProjectedRecurringTaskId } from './recurrence';
import { logInfo } from './logger';

export type NativeTrashItemsRestoreRequest = { requestId: string; taskIds: string[]; taskRevisions: Record<string, string>;
    projectIds: string[]; projectRevisions: Record<string, string> };
export type NativeTrashItemsRestoreResult = { count: number };
export type NativeTrashItemsRestoreScope = { tasks: Task[]; projects: Project[]; sections: Section[]; areas: Area[] };
export type NativePreparedTrashItemsRestore = {
    version: 1 | 2; request: NativeTrashItemsRestoreRequest; scope: NativeTrashItemsRestoreScope;
    effect: { tasks: { before: Task; after: Task }[]; projects: { before: Project; after: Project }[];
        sections: { before: Section; after: Section }[] };
    deviceIdBefore: string | null; deviceIdToInitialize: string | null; updateAt: string; result: NativeTrashItemsRestoreResult;
};
export type NativeTrashItemsRestoreEnvelope = { request: NativeTrashItemsRestoreRequest; prepared: NativePreparedTrashItemsRestore };
export type NativeTrashItemsRestorePreparation = { kind: 'prepared'; prepared: NativePreparedTrashItemsRestore };
export const NATIVE_TRASH_ITEMS_RESTORE_MAX_COUNT = 10_000;

const logTrashRestoreConfirmed = (count: number): void => {
    if (!isNativeRequestReceiptDurable('trashItemsRestore')) return;
    try {
        logInfo('Native Trash bulk Restore confirmed', { scope: 'native-host', category: 'storage',
            context: { releaseCheck: 'v1.3.5/ios-trash-bulk-restore', outcome: 'confirmed', count } });
    } catch { /* Diagnostics cannot change a durable result. */ }
};

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const same = sameSectionDeleteJson;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= limit;
const unique = (rows: { id: string }[]) => new Set(rows.map((row) => row.id)).size === rows.length;
const canonicalPayload = (value: unknown): string => JSON.stringify(value, (_name, item) => record(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);

// Archive's bounded closed JSON grammar, with both exact revision dictionaries.
const detach = <T>(value: unknown): T | null => {
    const valid = (item: unknown, depth: number, path: string): boolean => {
        if (depth > 24) return false;
        if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
        if (typeof item === 'number') return Number.isFinite(item);
        if (Array.isArray(item)) return item.length <= 100_000 && item.every((part) => valid(part, depth + 1, `${path}[]`));
        const revisions = /^(?:(?:request|prepared\.request)\.)?(?:taskRevisions|projectRevisions)$/.test(path);
        return record(item) && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)
            && Object.keys(item).length <= (revisions ? NATIVE_TRASH_ITEMS_RESTORE_MAX_COUNT : 128)
            && Object.entries(item).every(([name, part]) => !['__proto__', 'constructor', 'prototype'].includes(name)
                && valid(part, depth + 1, path ? `${path}.${name}` : name));
    };
    if (!isNativeJsonWithinBytes(value) || !valid(value, 0, '')) return null;
    return JSON.parse(JSON.stringify(value)) as T;
};
const jsonSafe = <T>(value: unknown): T | null => {
    // Scope rows come from saved storage; check size before allocating the journal copy.
    if (!isNativeJsonWithinBytes(value)) return null;
    try { return detach<T>(JSON.parse(JSON.stringify(value))); } catch { return null; }
};
const readRequest = (input: unknown): NativeTrashItemsRestoreRequest | null => {
    const row = detach<Record<string, unknown>>(input);
    if (!row || !exact(row, ['requestId', 'taskIds', 'taskRevisions', 'projectIds', 'projectRevisions'])
        || typeof row.requestId !== 'string' || !UUID.test(row.requestId)
        || !Array.isArray(row.taskIds) || !Array.isArray(row.projectIds)
        || row.taskIds.length + row.projectIds.length < 1 || row.taskIds.length + row.projectIds.length > NATIVE_TRASH_ITEMS_RESTORE_MAX_COUNT
        || !row.taskIds.every((id) => text(id, 500)) || !row.projectIds.every((id) => text(id, 200))
        || new Set(row.taskIds).size !== row.taskIds.length || new Set(row.projectIds).size !== row.projectIds.length
        || !record(row.taskRevisions) || !exact(row.taskRevisions, row.taskIds)
        || !record(row.projectRevisions) || !exact(row.projectRevisions, row.projectIds)
        || !Object.values(row.taskRevisions).every((revision) => text(revision, 200))
        || !Object.values(row.projectRevisions).every((revision) => text(revision, 200))) return null;
    return row as NativeTrashItemsRestoreRequest;
};

/** Original project membership plus every selected task's sanitation witness, in saved row order. */
export const trashItemsRestoreScope = (request: NativeTrashItemsRestoreRequest,
    data: Pick<AppData, 'tasks' | 'projects' | 'sections' | 'areas'>): NativeTrashItemsRestoreScope => {
    const selectedTasks = new Set(request.taskIds), selectedProjects = new Set(request.projectIds);
    const tasks = data.tasks.filter((row) => selectedTasks.has(row.id) || Boolean(row.projectId && selectedProjects.has(row.projectId)));
    const explicitTasks = tasks.filter((row) => selectedTasks.has(row.id));
    const sectionIds = new Set(explicitTasks.flatMap((row) => row.sectionId ? [row.sectionId] : []));
    const sections = (data.sections ?? []).filter((row) => selectedProjects.has(row.projectId) || sectionIds.has(row.id));
    const sectionById = buildEntityMap(sections);
    const projectIds = new Set([...request.projectIds, ...explicitTasks.flatMap((row) => {
        const parent = row.sectionId ? sectionById.get(row.sectionId)?.projectId : undefined;
        return [...(row.projectId ? [row.projectId] : []), ...(parent ? [parent] : [])];
    })]);
    const projects = data.projects.filter((row) => projectIds.has(row.id));
    const areaIds = new Set([...explicitTasks, ...projects.filter((row) => selectedProjects.has(row.id))]
        .flatMap((row) => row.areaId ? [row.areaId] : []));
    return { tasks, projects, sections, areas: (data.areas ?? []).filter((row) => areaIds.has(row.id)) };
};
const sourcesMatch = (request: NativeTrashItemsRestoreRequest, scope: NativeTrashItemsRestoreScope): boolean => {
    const tasks = buildEntityMap(scope.tasks), projects = buildEntityMap(scope.projects);
    return request.taskIds.every((id) => {
        const row = tasks.get(id);
        return row && iso(row.deletedAt) && !row.purgedAt && !isProjectedRecurringTaskId(id) && taskRevisionOf(row) === request.taskRevisions[id];
    }) && request.projectIds.every((id) => {
        const row = projects.get(id);
        return row && iso(row.deletedAt) && !row.purgedAt && revisionOf(row) === request.projectRevisions[id];
    });
};

/** Actual RN task-first policy, collapsed from pure intermediate rows to unique original/final pairs. */
export const trashItemsRestoreEffect = (prepared: Pick<NativePreparedTrashItemsRestore,
    'version' | 'request' | 'scope' | 'deviceIdBefore' | 'deviceIdToInitialize' | 'updateAt'>): NativePreparedTrashItemsRestore['effect'] | null => {
    const { request, scope } = prepared;
    if (!sourcesMatch(request, scope)) return null;
    const device = prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!;
    const selected = new Set(request.taskIds);
    const taskRows = planTaskMutations({ tasks: scope.tasks.filter((row) => selected.has(row.id)),
        state: { _allProjects: scope.projects, _allSections: scope.sections, _allAreas: scope.areas },
        buildUpdates: (row, { state }) => ({ deletedAt: undefined, ...sanitizeRestoredTaskContainerReferences(row, state) }),
        deviceId: device, now: prepared.updateAt });
    const taskAfter = buildEntityMap(taskRows), projectAfter = new Map<string, Project>(), sectionAfter = new Map<string, Section>();
    let tasks = scope.tasks.map((row) => taskAfter.get(row.id) ?? row), projects = scope.projects, sections = scope.sections;
    for (const id of request.projectIds) {
        const parent = projects.find((row) => row.id === id)!;
        const effect = projectRestoreEffect({ project: parent, tasks: tasks.filter((row) => row.projectId === id),
            sections: sections.filter((row) => row.projectId === id), area: scope.areas.find((row) => row.id === parent.areaId) ?? null },
        device, prepared.updateAt, prepared.version);
        projectAfter.set(id, effect.project.after);
        for (const pair of effect.tasks) taskAfter.set(pair.before.id, pair.after);
        for (const pair of effect.sections) sectionAfter.set(pair.before.id, pair.after);
        tasks = tasks.map((row) => taskAfter.get(row.id) ?? row);
        projects = projects.map((row) => projectAfter.get(row.id) ?? row);
        sections = sections.map((row) => sectionAfter.get(row.id) ?? row);
    }
    const pairs = <T extends { id: string }>(before: T[], after: Map<string, T>) =>
        before.flatMap((row) => after.has(row.id) ? [{ before: row, after: after.get(row.id)! }] : []);
    return { tasks: pairs(scope.tasks, taskAfter), projects: pairs(scope.projects, projectAfter), sections: pairs(scope.sections, sectionAfter) };
};

const validTask = (row: unknown): row is Task => record(row) && text(row.id, 500) && validRawTask(row, row.id)
    && (row.deletedAt === undefined || iso(row.deletedAt)) && (row.purgedAt === undefined || iso(row.purgedAt));
const validRawProject = (row: unknown): row is Project => record(row) && text(row.id, 500)
    && (row.deletedAt === undefined || iso(row.deletedAt)) && (row.purgedAt === undefined || iso(row.purgedAt))
    && validProject({ ...row, deletedAt: undefined, purgedAt: undefined }, row.id);
const areaKeys = new Set(AREA_SYNC_FIELD_SCHEMA.map((field) => field.name));
const validArea = (row: unknown): row is Area => {
    if (!record(row) || !text(row.id, 500) || Object.keys(row).some((key) => !areaKeys.has(key as keyof Area))
        || typeof row.name !== 'string' || typeof row.order !== 'number' || !Number.isFinite(row.order)
        || !iso(row.createdAt) || !iso(row.updatedAt) || row.deletedAt !== undefined && !iso(row.deletedAt)
        || ['color', 'icon', 'revBy'].some((key) => row[key] !== undefined && typeof row[key] !== 'string')
        || row.rev !== undefined && !(typeof row.rev === 'number' && Number.isSafeInteger(row.rev) && row.rev >= 0)) return false;
    try { areaToSqliteRow(row as unknown as Area, row.updatedAt); return true; } catch { return false; }
};
const readEnvelope = (input: unknown): NativeTrashItemsRestoreEnvelope | null => {
    const envelope = detach<Record<string, unknown>>(input);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request), raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'scope', 'effect', 'deviceIdBefore', 'deviceIdToInitialize', 'updateAt', 'result'])
        || (raw.version !== 1 && raw.version !== 2) || !same(raw.request, request) || !record(raw.scope) || !exact(raw.scope, ['tasks', 'projects', 'sections', 'areas'])
        || !Array.isArray(raw.scope.tasks) || !raw.scope.tasks.every(validTask) || !unique(raw.scope.tasks)
        || !Array.isArray(raw.scope.projects) || !raw.scope.projects.every(validRawProject) || !unique(raw.scope.projects)
        || !Array.isArray(raw.scope.sections) || !raw.scope.sections.every((row) => record(row) && text(row.id, 500)
            && text(row.projectId, 500) && validSection(row, row.id, row.projectId)) || !unique(raw.scope.sections)
        || !Array.isArray(raw.scope.areas) || !raw.scope.areas.every(validArea) || !unique(raw.scope.areas)
        || !record(raw.effect) || !exact(raw.effect, ['tasks', 'projects', 'sections'])
        || !Array.isArray(raw.effect.tasks) || !Array.isArray(raw.effect.projects) || !Array.isArray(raw.effect.sections)
        || (raw.deviceIdBefore !== null && !text(raw.deviceIdBefore, 500))
        || (raw.deviceIdBefore === null ? typeof raw.deviceIdToInitialize !== 'string' || !UUID.test(raw.deviceIdToInitialize) : raw.deviceIdToInitialize !== null)
        || !iso(raw.updateAt) || !record(raw.result) || !exact(raw.result, ['count'])
        || raw.result.count !== request.taskIds.length + request.projectIds.length) return null;
    try {
        const prepared = raw as unknown as NativePreparedTrashItemsRestore;
        if (!same(trashItemsRestoreScope(request, prepared.scope), prepared.scope)) return null;
        const expected = trashItemsRestoreEffect(prepared);
        return expected && same(expected, prepared.effect)
            && [...prepared.effect.tasks, ...prepared.effect.projects, ...prepared.effect.sections]
                .every((pair) => record(pair) && exact(pair, ['before', 'after'])) ? envelope as NativeTrashItemsRestoreEnvelope : null;
    } catch { return null; }
};

export function createTrashItemsRestoreMethods(deps: { readiness: () => NativeHostResult<null>; save: () => Promise<NativeHostResult<null>> }) {
    const saves = createAreaSaveGuard(deps.save);
    let pending: { envelope: NativeTrashItemsRestoreEnvelope; adapter: ReturnType<typeof getStorageAdapter>;
        boundary: PreparedNativeSaveBoundary | undefined } | null = null;
    const payload = (envelope: NativeTrashItemsRestoreEnvelope) => canonicalPayload(['trashItemsRestore', envelope]);
    const checkAuthority = (envelope: NativeTrashItemsRestoreEnvelope, authority: PreparedAreaAuthority): NativeHostResult<null> => {
        const current = trashItemsRestoreScope(envelope.request, authority.snapshot), prepared = envelope.prepared;
        if (!same(current, prepared.scope) || (authority.snapshot.settings.deviceId ?? null) !== prepared.deviceIdBefore
            || !same(trashItemsRestoreEffect({ ...prepared, scope: current }), prepared.effect))
            return fail('STALE_REVISION', 'Trash selection or its saved container membership changed');
        return { ok: true, value: null };
    };
    const apply = (envelope: NativeTrashItemsRestoreEnvelope, authority: PreparedAreaAuthority) =>
        useTaskStore.getState().commitPreparedTrashItemsRestore(envelope.prepared, authority);
    const receipts = createNativeRequestReceipts({ save: async (requestId) => {
        const owned = pending;
        if (!owned || owned.envelope.request.requestId !== requestId) return fail('SAVE_FAILED', 'Trash Restore has no owned raw save');
        if (useTaskStore.getState().persistenceFailure) {
            if (!saves.mayApply(owned.envelope, owned.adapter)) return fail('SAVE_FAILED', 'Trash Restore has an unrelated persistence failure');
            const read = await readAreaDurableData(true, true); if (!read.ok) return read;
            if (read.value.adapter !== owned.adapter) return fail('STALE_REVISION', 'Trash Restore storage changed before retry');
            const checked = checkAuthority(owned.envelope, read.value.authority); if (!checked.ok) return checked;
            const applied = await apply(owned.envelope, read.value.authority);
            if (!applied.success || applied.outcome !== 'applied') return fail('STALE_REVISION', applied.error ?? 'Trash Restore retry was superseded');
            owned.boundary = read.value.authority.saveBoundary;
        }
        const saved = await saves.finish(owned.envelope, owned.adapter, false, owned.boundary);
        if (saved.ok) pending = null;
        return saved;
    } });
    return {
        async prepareTrashItemsRestore(input: NativeTrashItemsRestoreRequest): Promise<NativeHostResult<NativeTrashItemsRestorePreparation>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'Select saved Trash rows with their exact revisions; select fewer items if the request is too large');
            const memory = useTaskStore.getState();
            if (!sourcesMatch(request, { tasks: memory._allTasks, projects: memory._allProjects, sections: [], areas: [] }))
                return fail('STALE_REVISION', 'Trash selection changed since it was shown');
            const read = await readAreaDurableData(false, true); if (!read.ok) return read;
            const scope = trashItemsRestoreScope(request, read.value.authority.snapshot);
            if (!sourcesMatch(request, scope)) return fail('STALE_REVISION', 'Saved Trash selection changed');
            const device = ensureDeviceId(read.value.authority.snapshot.settings);
            const base = { version: 2 as const, request, scope, deviceIdBefore: read.value.authority.snapshot.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null, updateAt: new Date().toISOString(),
                result: { count: request.taskIds.length + request.projectIds.length } };
            if (!isNativeJsonWithinBytes({ request, prepared: base })) return fail('INVALID_INPUT', 'Trash Restore journal is too large; select fewer items');
            let effect; try { effect = trashItemsRestoreEffect(base); } catch { effect = null; }
            const prepared = effect && jsonSafe<NativePreparedTrashItemsRestore>({ ...base, effect });
            return prepared && readEnvelope({ request, prepared }) ? { ok: true, value: { kind: 'prepared', prepared } }
                : fail('INVALID_INPUT', 'Trash Restore cannot prepare these rows or its journal is too large; select fewer items');
        },
        validatePreparedTrashItemsRestore(input: unknown): NativeHostResult<NativeTrashItemsRestoreResult> {
            const envelope = readEnvelope(input);
            return envelope ? { ok: true, value: envelope.prepared.result } : fail('INVALID_INPUT', 'Prepared Trash Restore is malformed');
        },
        trashItemsRestoreOutcome(input: unknown): NativeHostResult<NativeTrashItemsRestoreResult | null> {
            const envelope = readEnvelope(input);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared Trash Restore is malformed');
            const saved = receipts.saved<NativeTrashItemsRestoreResult>(envelope.request.requestId, payload(envelope));
            return saved?.ok && !same(saved.value, envelope.prepared.result) ? fail('INVALID_INPUT', 'Saved Trash Restore result does not match its journal')
                : saved ?? { ok: true, value: null };
        },
        async commitPreparedTrashItemsRestore(input: unknown): Promise<NativeHostResult<NativeTrashItemsRestoreResult>> {
            const envelope = readEnvelope(input);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared Trash Restore is malformed');
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const boundPayload = payload(envelope), saved = receipts.saved<NativeTrashItemsRestoreResult>(envelope.request.requestId, boundPayload);
            if (saved) {
                if (saved.ok && !same(saved.value, envelope.prepared.result))
                    return fail('INVALID_INPUT', 'Saved Trash Restore result does not match its journal');
                if (saved.ok) logTrashRestoreConfirmed(saved.value.count);
                return saved;
            }
            let prewriteFailure: NativeHostResult<never> | null = null;
            const notLanded = (message: string): NativeHostResult<never> => {
                prewriteFailure = fail('SAVE_FAILED', message); return { ok: false, error: { code: 'ACTION_FAILED', message } };
            };
            const confirmed = await receipts.run(envelope.request.requestId, boundPayload, async () => {
                if (useTaskStore.getState().persistenceFailure) return notLanded('Trash Restore has an unresolved persistence failure');
                const read = await readAreaDurableData(false, true);
                if (!read.ok) return read.error.code === 'SAVE_FAILED' ? notLanded(read.error.message) : read;
                const checked = checkAuthority(envelope, read.value.authority); if (!checked.ok) return checked;
                const applied = await apply(envelope, read.value.authority);
                if (!applied.success || applied.outcome !== 'applied') return fail('STALE_REVISION', applied.error ?? 'Trash Restore conflicts with saved data');
                pending = { envelope, adapter: read.value.adapter, boundary: read.value.authority.saveBoundary };
                return { ok: true, value: envelope.prepared.result };
            });
            if (prewriteFailure) return prewriteFailure;
            if (confirmed.ok && !same(confirmed.value, envelope.prepared.result))
                return fail('INVALID_INPUT', 'Saved Trash Restore result does not match its journal');
            if (confirmed.ok) logTrashRestoreConfirmed(confirmed.value.count);
            return confirmed;
        },
    };
}
