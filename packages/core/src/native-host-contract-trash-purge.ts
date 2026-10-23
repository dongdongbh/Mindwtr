import type { NativeHostResult } from './native-host-contract';
import type { AppData, PendingRemoteAttachmentDelete, Project, Section, Task } from './types';
import type { PreparedAreaAuthority, PreparedNativeSaveBoundary } from './store-types';
import { exact, iso, record, validProject } from './native-host-contract-project-shared';
import { validSection } from './native-host-contract-project-section-rename';
import { validRawTask } from './native-host-contract-task-save';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { createAreaSaveGuard, readAreaDurableData } from './native-host-contract-area-durable';
import { createNativeRequestReceipts, isNativeRequestReceiptDurable, revisionOf, taskRevisionOf } from './native-request-receipts';
import { sameSectionDeleteJson } from './store-projects/section-actions';
import { projectPurgeEffect } from './store-projects/project-actions';
import { buildEntityMap, ensureDeviceId } from './store-helpers';
import { planTaskMutations } from './store-tasks';
import { getStorageAdapter, useTaskStore } from './store';
import { isProjectedRecurringTaskId } from './recurrence';
import { settingsWithPurgedParentAttachmentDeletes } from './attachment-cleanup';
import { logInfo } from './logger';

export type NativeTrashItemsPurgeRequest = { requestId: string; taskIds: string[]; taskRevisions: Record<string, string>;
    projectIds: string[]; projectRevisions: Record<string, string> };
export type NativeTrashItemsPurgeResult = { count: number };
type CloudReferences = { kind: 'task' | 'project'; id: string; cloudKeys: string[] };
export type NativeTrashItemsPurgeScope = { tasks: Task[]; projects: Project[]; sections: Section[];
    references: CloudReferences[]; pendingRemoteDeletes: PendingRemoteAttachmentDelete[] | null };
export type NativePreparedTrashItemsPurge = {
    version: 1; request: NativeTrashItemsPurgeRequest; scope: NativeTrashItemsPurgeScope;
    effect: { tasks: { before: Task; after: Task }[]; projects: { before: Project; after: Project }[];
        sections: { before: Section; after: Section }[]; pendingRemoteDeletes: PendingRemoteAttachmentDelete[] | null };
    deviceIdBefore: string | null; deviceIdToInitialize: string | null; updateAt: string; result: NativeTrashItemsPurgeResult;
};
export type NativeTrashItemsPurgeEnvelope = { request: NativeTrashItemsPurgeRequest; prepared: NativePreparedTrashItemsPurge };
export type NativeTrashItemsPurgePreparation = { kind: 'prepared'; prepared: NativePreparedTrashItemsPurge };
export const NATIVE_TRASH_ITEMS_PURGE_MAX_COUNT = 10_000;

const logTrashPurgeConfirmed = (count: number): void => {
    if (!isNativeRequestReceiptDurable('trashItemsPurge')) return;
    try {
        logInfo('Native Trash purge confirmed', { scope: 'native-host', category: 'storage',
            context: { releaseCheck: 'v1.3.5/ios-trash-purge', outcome: 'confirmed', count } });
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
            && Object.keys(item).length <= (revisions ? NATIVE_TRASH_ITEMS_PURGE_MAX_COUNT : 128)
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
const readRequest = (input: unknown): NativeTrashItemsPurgeRequest | null => {
    const row = detach<Record<string, unknown>>(input);
    if (!row || !exact(row, ['requestId', 'taskIds', 'taskRevisions', 'projectIds', 'projectRevisions'])
        || typeof row.requestId !== 'string' || !UUID.test(row.requestId)
        || !Array.isArray(row.taskIds) || !Array.isArray(row.projectIds)
        || row.taskIds.length + row.projectIds.length < 1 || row.taskIds.length + row.projectIds.length > NATIVE_TRASH_ITEMS_PURGE_MAX_COUNT
        || !row.taskIds.every((id) => text(id, 500)) || !row.projectIds.every((id) => text(id, 200))
        || new Set(row.taskIds).size !== row.taskIds.length || new Set(row.projectIds).size !== row.projectIds.length
        || !record(row.taskRevisions) || !exact(row.taskRevisions, row.taskIds)
        || !record(row.projectRevisions) || !exact(row.projectRevisions, row.projectIds)
        || !Object.values(row.taskRevisions).every((revision) => text(revision, 200))
        || !Object.values(row.projectRevisions).every((revision) => text(revision, 200))) return null;
    return row as NativeTrashItemsPurgeRequest;
};

const cloudCandidates = (request: NativeTrashItemsPurgeRequest, data: Pick<AppData, 'tasks' | 'projects'>): Set<string> => {
    const taskIds = new Set(request.taskIds), projectIds = new Set(request.projectIds);
    return new Set([...data.tasks.filter((row) => taskIds.has(row.id)), ...data.projects.filter((row) => projectIds.has(row.id))]
        .flatMap((row) => (row.attachments ?? []).filter((item) => item.kind === 'file' && item.cloudKey).map((item) => item.cloudKey!)));
};
const cloudReferences = (request: NativeTrashItemsPurgeRequest, data: Pick<AppData, 'tasks' | 'projects'>): CloudReferences[] => {
    const candidates = cloudCandidates(request, data);
    const parents = (kind: CloudReferences['kind'], rows: readonly (Task | Project)[]): CloudReferences[] => rows.flatMap((row) => {
        if (row.purgedAt) return [];
        const cloudKeys = [...new Set((row.attachments ?? []).filter((item) => item.kind === 'file' && item.cloudKey
            && candidates.has(item.cloudKey)).map((item) => item.cloudKey!))].sort();
        return cloudKeys.length ? [{ kind, id: row.id, cloudKeys }] : [];
    });
    return [...parents('task', data.tasks), ...parents('project', data.projects)].sort((a, b) =>
        a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
};

/** Complete project/section membership and only the cloud identities used by the existing cleanup helper. */
export const trashItemsPurgeScope = (request: NativeTrashItemsPurgeRequest,
    data: Pick<AppData, 'tasks' | 'projects' | 'sections' | 'settings'>): NativeTrashItemsPurgeScope => {
    const selectedTasks = new Set(request.taskIds), selectedProjects = new Set(request.projectIds);
    const sections = (data.sections ?? []).filter((row) => selectedProjects.has(row.projectId));
    const sectionIds = new Set(sections.map((row) => row.id));
    const tasks = data.tasks.filter((row) => selectedTasks.has(row.id) || Boolean(row.projectId && selectedProjects.has(row.projectId))
        || Boolean(row.sectionId && sectionIds.has(row.sectionId)));
    return { tasks, projects: data.projects.filter((row) => selectedProjects.has(row.id)), sections,
        references: cloudReferences(request, data), pendingRemoteDeletes: data.settings.attachments?.pendingRemoteDeletes ?? null };
};
const sourcesMatch = (request: NativeTrashItemsPurgeRequest, scope: Pick<NativeTrashItemsPurgeScope, 'tasks' | 'projects'>): boolean => {
    const tasks = buildEntityMap(scope.tasks), projects = buildEntityMap(scope.projects);
    return request.taskIds.every((id) => {
        const row = tasks.get(id);
        return row && iso(row.deletedAt) && !row.purgedAt && !isProjectedRecurringTaskId(id) && taskRevisionOf(row) === request.taskRevisions[id];
    }) && request.projectIds.every((id) => {
        const row = projects.get(id);
        return row && iso(row.deletedAt) && !row.purgedAt && revisionOf(row) === request.projectRevisions[id];
    });
};

/** Actual RN task-first row policy and the existing all-parent cleanup helper, frozen as one effect. */
export const trashItemsPurgeEffect = (prepared: Pick<NativePreparedTrashItemsPurge,
    'request' | 'scope' | 'deviceIdBefore' | 'deviceIdToInitialize' | 'updateAt'>): NativePreparedTrashItemsPurge['effect'] | null => {
    const { request, scope } = prepared;
    if (!sourcesMatch(request, scope)) return null;
    const device = prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!;
    const selected = new Set(request.taskIds);
    const taskRows = planTaskMutations({ tasks: scope.tasks.filter((row) => selected.has(row.id)),
        state: null, buildUpdates: () => ({ purgedAt: prepared.updateAt }),
        deviceId: device, now: prepared.updateAt });
    const taskAfter = buildEntityMap(taskRows), projectAfter = new Map<string, Project>(), sectionAfter = new Map<string, Section>();
    let tasks = scope.tasks.map((row) => taskAfter.get(row.id) ?? row), projects = scope.projects, sections = scope.sections;
    for (const id of request.projectIds) {
        const parent = projects.find((row) => row.id === id)!;
        const effect = projectPurgeEffect(parent, tasks, sections, device, prepared.updateAt);
        projectAfter.set(id, effect.project.after);
        for (const pair of effect.tasks) taskAfter.set(pair.before.id, pair.after);
        for (const pair of effect.sections) sectionAfter.set(pair.before.id, pair.after);
        tasks = tasks.map((row) => taskAfter.get(row.id) ?? row);
        projects = projects.map((row) => projectAfter.get(row.id) ?? row);
        sections = sections.map((row) => sectionAfter.get(row.id) ?? row);
    }
    const pairs = <T extends { id: string }>(before: T[], after: Map<string, T>) =>
        before.flatMap((row) => after.has(row.id) ? [{ before: row, after: after.get(row.id)! }] : []);
    // Keep saved selected-parent/attachment order for RN's task-first cleanup sequence.
    // Outside rows contribute only relevant nonpurged cloud identities, including deleted parents/attachments.
    const parents = <T extends Task | Project>(kind: CloudReferences['kind'], known: T[]): T[] => {
        const ids = new Set(known.map((row) => row.id));
        return [...known, ...scope.references.filter((row) => row.kind === kind && !ids.has(row.id))
            .map((row) => ({ id: row.id, attachments: row.cloudKeys.map((cloudKey) => ({ kind: 'file', cloudKey })) }) as T)];
    };
    let cleanupTasks = parents('task', scope.tasks), cleanupProjects = parents('project', scope.projects);
    let cleanup: AppData['settings'] = scope.pendingRemoteDeletes === null ? {}
        : { attachments: { pendingRemoteDeletes: scope.pendingRemoteDeletes } };
    cleanup = settingsWithPurgedParentAttachmentDeletes(cleanup, cleanupTasks, cleanupProjects, selected, new Set());
    cleanupTasks = cleanupTasks.map((row) => selected.has(row.id) ? taskAfter.get(row.id)! : row);
    for (const id of request.projectIds) {
        cleanup = settingsWithPurgedParentAttachmentDeletes(cleanup, cleanupTasks, cleanupProjects, new Set(), new Set([id]));
        cleanupProjects = cleanupProjects.map((row) => row.id === id ? projectAfter.get(id)! : row);
    }
    return { tasks: pairs(scope.tasks, taskAfter), projects: pairs(scope.projects, projectAfter), sections: pairs(scope.sections, sectionAfter),
        pendingRemoteDeletes: cleanup.attachments?.pendingRemoteDeletes ?? null };
};

const validTask = (row: unknown): row is Task => record(row) && text(row.id, 500) && validRawTask(row, row.id)
    && (row.deletedAt === undefined || iso(row.deletedAt)) && (row.purgedAt === undefined || iso(row.purgedAt));
const validRawProject = (row: unknown): row is Project => record(row) && text(row.id, 500)
    && (row.deletedAt === undefined || iso(row.deletedAt)) && (row.purgedAt === undefined || iso(row.purgedAt))
    && validProject({ ...row, deletedAt: undefined, purgedAt: undefined }, row.id);
const validPendingDeletes = (rows: unknown): rows is PendingRemoteAttachmentDelete[] | null => rows === null
    || Array.isArray(rows) && rows.every((row) => record(row) && Object.keys(row).every((name) =>
        ['cloudKey', 'title', 'attempts', 'lastErrorAt'].includes(name)) && typeof row.cloudKey === 'string' && Boolean(row.cloudKey)
        && (row.title === undefined || typeof row.title === 'string')
        && (row.attempts === undefined || typeof row.attempts === 'number' && Number.isSafeInteger(row.attempts) && row.attempts >= 0)
        && (row.lastErrorAt === undefined || iso(row.lastErrorAt)));
const scopeIsClosed = (request: NativeTrashItemsPurgeRequest, scope: NativeTrashItemsPurgeScope): boolean => {
    const taskIds = new Set(request.taskIds), projectIds = new Set(request.projectIds), sectionIds = new Set(scope.sections.map((row) => row.id));
    if (scope.projects.some((row) => !projectIds.has(row.id)) || scope.sections.some((row) => !projectIds.has(row.projectId))
        || scope.tasks.some((row) => !taskIds.has(row.id) && !projectIds.has(row.projectId ?? '') && !sectionIds.has(row.sectionId ?? ''))) return false;
    const candidates = cloudCandidates(request, scope), referenceIds = new Set<string>();
    for (const reference of scope.references) {
        if (!record(reference) || !exact(reference, ['kind', 'id', 'cloudKeys']) || !['task', 'project'].includes(reference.kind)
            || !text(reference.id, 500) || !Array.isArray(reference.cloudKeys) || !reference.cloudKeys.length
            || reference.cloudKeys.some((item) => typeof item !== 'string' || !candidates.has(item))
            || new Set(reference.cloudKeys).size !== reference.cloudKeys.length
            || !same([...reference.cloudKeys].sort(), reference.cloudKeys)) return false;
        const identity = JSON.stringify([reference.kind, reference.id]);
        if (referenceIds.has(identity)) return false;
        referenceIds.add(identity);
    }
    const knownTasks = new Set(scope.tasks.map((row) => row.id)), knownProjects = new Set(scope.projects.map((row) => row.id));
    return same(scope.references.filter((row) => (row.kind === 'task' ? knownTasks : knownProjects).has(row.id)), cloudReferences(request, scope))
        && same([...scope.references].sort((a, b) => a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0), scope.references);
};
const readEnvelope = (input: unknown): NativeTrashItemsPurgeEnvelope | null => {
    const envelope = detach<Record<string, unknown>>(input);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request), raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'scope', 'effect', 'deviceIdBefore', 'deviceIdToInitialize', 'updateAt', 'result'])
        || raw.version !== 1 || !same(raw.request, request) || !record(raw.scope)
        || !exact(raw.scope, ['tasks', 'projects', 'sections', 'references', 'pendingRemoteDeletes'])
        || !Array.isArray(raw.scope.tasks) || !raw.scope.tasks.every(validTask) || !unique(raw.scope.tasks)
        || !Array.isArray(raw.scope.projects) || !raw.scope.projects.every(validRawProject) || !unique(raw.scope.projects)
        || !Array.isArray(raw.scope.sections) || !raw.scope.sections.every((row) => record(row) && text(row.id, 500)
            && text(row.projectId, 500) && validSection(row, row.id, row.projectId)) || !unique(raw.scope.sections)
        || !Array.isArray(raw.scope.references) || !validPendingDeletes(raw.scope.pendingRemoteDeletes)
        || !record(raw.effect) || !exact(raw.effect, ['tasks', 'projects', 'sections', 'pendingRemoteDeletes'])
        || !Array.isArray(raw.effect.tasks) || !Array.isArray(raw.effect.projects) || !Array.isArray(raw.effect.sections)
        || (raw.deviceIdBefore !== null && !text(raw.deviceIdBefore, 500))
        || (raw.deviceIdBefore === null ? typeof raw.deviceIdToInitialize !== 'string' || !UUID.test(raw.deviceIdToInitialize) : raw.deviceIdToInitialize !== null)
        || !iso(raw.updateAt) || !record(raw.result) || !exact(raw.result, ['count'])
        || raw.result.count !== request.taskIds.length + request.projectIds.length) return null;
    try {
        const prepared = raw as unknown as NativePreparedTrashItemsPurge;
        if (!scopeIsClosed(request, prepared.scope)) return null;
        const expected = trashItemsPurgeEffect(prepared);
        return expected && same(expected, prepared.effect)
            && [...prepared.effect.tasks, ...prepared.effect.projects, ...prepared.effect.sections]
                .every((pair) => record(pair) && exact(pair, ['before', 'after'])) ? envelope as NativeTrashItemsPurgeEnvelope : null;
    } catch { return null; }
};

export function createTrashItemsPurgeMethods(deps: { readiness: () => NativeHostResult<null>; save: () => Promise<NativeHostResult<null>> }) {
    const saves = createAreaSaveGuard(deps.save);
    let pending: { envelope: NativeTrashItemsPurgeEnvelope; adapter: ReturnType<typeof getStorageAdapter>;
        boundary: PreparedNativeSaveBoundary | undefined } | null = null;
    const payload = (envelope: NativeTrashItemsPurgeEnvelope) => canonicalPayload(['trashItemsPurge', envelope]);
    const checkAuthority = (envelope: NativeTrashItemsPurgeEnvelope, authority: PreparedAreaAuthority): NativeHostResult<null> => {
        const current = trashItemsPurgeScope(envelope.request, authority.snapshot), prepared = envelope.prepared;
        if (!same(current, prepared.scope) || (authority.snapshot.settings.deviceId ?? null) !== prepared.deviceIdBefore
            || !same(trashItemsPurgeEffect({ ...prepared, scope: current }), prepared.effect))
            return fail('STALE_REVISION', 'Trash selection or its saved container membership changed');
        return { ok: true, value: null };
    };
    const apply = (envelope: NativeTrashItemsPurgeEnvelope, authority: PreparedAreaAuthority) =>
        useTaskStore.getState().commitPreparedTrashItemsPurge(envelope.prepared, authority);
    const receipts = createNativeRequestReceipts({ save: async (requestId) => {
        const owned = pending;
        if (!owned || owned.envelope.request.requestId !== requestId) return fail('SAVE_FAILED', 'Trash purge has no owned raw save');
        if (useTaskStore.getState().persistenceFailure) {
            if (!saves.mayApply(owned.envelope, owned.adapter)) return fail('SAVE_FAILED', 'Trash purge has an unrelated persistence failure');
            const read = await readAreaDurableData(true, true); if (!read.ok) return read;
            if (read.value.adapter !== owned.adapter) return fail('STALE_REVISION', 'Trash purge storage changed before retry');
            const checked = checkAuthority(owned.envelope, read.value.authority); if (!checked.ok) return checked;
            const applied = await apply(owned.envelope, read.value.authority);
            if (!applied.success || applied.outcome !== 'applied') return fail('STALE_REVISION', applied.error ?? 'Trash purge retry was superseded');
            owned.boundary = read.value.authority.saveBoundary;
        }
        const saved = await saves.finish(owned.envelope, owned.adapter, false, owned.boundary);
        if (saved.ok) pending = null;
        return saved;
    } });
    return {
        async prepareTrashItemsPurge(input: NativeTrashItemsPurgeRequest): Promise<NativeHostResult<NativeTrashItemsPurgePreparation>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'Select saved Trash rows with their exact revisions; select fewer items if the request is too large');
            const memory = useTaskStore.getState();
            if (!sourcesMatch(request, { tasks: memory._allTasks, projects: memory._allProjects }))
                return fail('STALE_REVISION', 'Trash selection changed since it was shown');
            const read = await readAreaDurableData(false, true); if (!read.ok) return read;
            const scope = trashItemsPurgeScope(request, read.value.authority.snapshot);
            if (!sourcesMatch(request, scope)) return fail('STALE_REVISION', 'Saved Trash selection changed');
            const device = ensureDeviceId(read.value.authority.snapshot.settings);
            const base = { version: 1 as const, request, scope, deviceIdBefore: read.value.authority.snapshot.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null, updateAt: new Date().toISOString(),
                result: { count: request.taskIds.length + request.projectIds.length } };
            if (!isNativeJsonWithinBytes({ request, prepared: base })) return fail('INVALID_INPUT', 'Trash purge journal is too large; select fewer items');
            let effect; try { effect = trashItemsPurgeEffect(base); } catch { effect = null; }
            const prepared = effect && jsonSafe<NativePreparedTrashItemsPurge>({ ...base, effect });
            return prepared && readEnvelope({ request, prepared }) ? { ok: true, value: { kind: 'prepared', prepared } }
                : fail('INVALID_INPUT', 'Trash purge cannot prepare these rows or its journal is too large; select fewer items');
        },
        validatePreparedTrashItemsPurge(input: unknown): NativeHostResult<NativeTrashItemsPurgeResult> {
            const envelope = readEnvelope(input);
            return envelope ? { ok: true, value: envelope.prepared.result } : fail('INVALID_INPUT', 'Prepared Trash purge is malformed');
        },
        trashItemsPurgeOutcome(input: unknown): NativeHostResult<NativeTrashItemsPurgeResult | null> {
            const envelope = readEnvelope(input);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared Trash purge is malformed');
            const saved = receipts.saved<NativeTrashItemsPurgeResult>(envelope.request.requestId, payload(envelope));
            return saved?.ok && !same(saved.value, envelope.prepared.result) ? fail('INVALID_INPUT', 'Saved Trash purge result does not match its journal')
                : saved ?? { ok: true, value: null };
        },
        async commitPreparedTrashItemsPurge(input: unknown): Promise<NativeHostResult<NativeTrashItemsPurgeResult>> {
            const envelope = readEnvelope(input);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared Trash purge is malformed');
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const boundPayload = payload(envelope), saved = receipts.saved<NativeTrashItemsPurgeResult>(envelope.request.requestId, boundPayload);
            if (saved) {
                if (saved.ok && !same(saved.value, envelope.prepared.result))
                    return fail('INVALID_INPUT', 'Saved Trash purge result does not match its journal');
                if (saved.ok) logTrashPurgeConfirmed(saved.value.count);
                return saved;
            }
            let prewriteFailure: NativeHostResult<never> | null = null;
            const notLanded = (message: string): NativeHostResult<never> => {
                prewriteFailure = fail('SAVE_FAILED', message); return { ok: false, error: { code: 'ACTION_FAILED', message } };
            };
            const confirmed = await receipts.run(envelope.request.requestId, boundPayload, async () => {
                if (useTaskStore.getState().persistenceFailure) return notLanded('Trash purge has an unresolved persistence failure');
                const read = await readAreaDurableData(false, true);
                if (!read.ok) return read.error.code === 'SAVE_FAILED' ? notLanded(read.error.message) : read;
                const checked = checkAuthority(envelope, read.value.authority); if (!checked.ok) return checked;
                const applied = await apply(envelope, read.value.authority);
                if (!applied.success || applied.outcome !== 'applied') return fail('STALE_REVISION', applied.error ?? 'Trash purge conflicts with saved data');
                pending = { envelope, adapter: read.value.adapter, boundary: read.value.authority.saveBoundary };
                return { ok: true, value: envelope.prepared.result };
            });
            if (prewriteFailure) return prewriteFailure;
            if (confirmed.ok && !same(confirmed.value, envelope.prepared.result))
                return fail('INVALID_INPUT', 'Saved Trash purge result does not match its journal');
            if (confirmed.ok) logTrashPurgeConfirmed(confirmed.value.count);
            return confirmed;
        },
    };
}
