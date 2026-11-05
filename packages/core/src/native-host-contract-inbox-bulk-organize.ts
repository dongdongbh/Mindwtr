import type { NativeHostResult } from './native-host-contract';
import type { AppData, Project, Section, Task } from './types';
import type { PreparedAreaAuthority, PreparedNativeSaveBoundary } from './store-types';
import type { NativeProjectTasksOrganizeRequest, NativeProjectTasksOrganizePrepared } from './native-host-contract-project-bulk-organize';
import type { NativeInboxTasksMoveParams } from './native-host-contract-inbox-bulk-status';
import type { RecurrenceProjection } from './recurrence';
import { projectNextRecurringTask } from './recurrence';
import { exact, iso, record } from './native-host-contract-project-shared';
import { validSection } from './native-host-contract-project-section-rename';
import { validFrozenFocusDate } from './native-host-contract-task-focus';
import { historyRowLoadProjection } from './native-host-contract-task-checklist';
import { readBulkOrganizeDraftShape } from './native-host-contract-bulk-actions';
import { BULK_ORGANIZE_KEEP, BULK_ORGANIZE_NONE, EMPTY_BULK_ORGANIZE_DRAFT, buildBulkOrganizeInput,
    getBulkOrganizeAreaOptions, getBulkOrganizeProjectOptions, planBulkOrganize, type BulkOrganizeDraft } from './task-list-bulk-actions';
import { createAreaSaveGuard, readAreaDurableData } from './native-host-contract-area-durable';
import { createNativeRequestReceipts, isNativeRequestReceiptDurable, NativeReceiptSqliteAdapter } from './native-request-receipts';
import { taskEditValuesEqual as same } from './json-value-equality';
import { buildEntityMap, ensureDeviceId } from './store-helpers';
import { planTaskBatchUpdateEffects, prepareTaskBatchUpdatesForStore } from './store-tasks';
import { getStorageAdapter, useTaskStore } from './store';
import { projectFocusDateValues, type FocusDateProjection } from './task-utils';
import { generateUUID } from './uuid';
import { logInfo } from './logger';
import { referenceBatchModules } from './store-reference-batch-modules';
import { detachReferenceBatchJson, detachReferenceBatchValue, readStatusBatchSelectionRequest, statusBatchSourcesMatch,
    statusBatchSettings, rawReferenceBatchScope, loadedReferenceBatchProject, referenceBatchSettingsReadable,
    requiredReferenceBatchDates, validReferenceBatchTask, validReferenceBatchProject, validReferenceBatchArea,
    validReferenceBatchRecurrenceProjection, referenceTasksMoveScope, type NativeReferenceTasksMoveScope } from './native-host-contract-reference-bulk-status';

export type NativeInboxTasksOrganizeRequest = { requestId: string; source: 'inbox'; taskIds: string[];
    taskRevisions: Record<string, string>; draft: BulkOrganizeDraft; params: NativeInboxTasksMoveParams };
export type NativeInboxTasksOrganizeResult = { count: number; changed: boolean };
export type NativeInboxTasksOrganizePrepared = {
    version: 1; request: NativeInboxTasksOrganizeRequest; scope: NativeReferenceTasksMoveScope;
    effect: { tasks: { before: Task; after: Task }[]; createdTasks: Task[];
        projects: { before: Project; after: Project }[]; sections: { before: Section; after: Section }[] };
    deviceIdBefore: string | null; deviceIdToInitialize: string | null;
    updateAt: string; preparedLocalDay: string; preparedOffsetMinutes: number;
    boundaryOffsetMinutes: number; futureBoundary: string; dates: FocusDateProjection[];
    recurrenceProjections: { id: string; projection: RecurrenceProjection | null }[];
    allocatedIds: string[]; result: NativeInboxTasksOrganizeResult;
};
export type NativeInboxTasksOrganizeEnvelope = { request: NativeInboxTasksOrganizeRequest; prepared: NativeInboxTasksOrganizePrepared };
export type NativeInboxTasksOrganizePreparation = { kind: 'noop'; result: { count: 0; changed: false } }
    | { kind: 'prepared'; prepared: NativeInboxTasksOrganizePrepared };
type OrganizeSource = 'inbox' | 'project';
type OrganizeRequest = NativeInboxTasksOrganizeRequest | NativeProjectTasksOrganizeRequest;
type OrganizePrepared = Omit<NativeInboxTasksOrganizePrepared, 'request'> & { request: OrganizeRequest };
type OrganizeEnvelope = { request: OrganizeRequest; prepared: OrganizePrepared };
type OrganizePreparation = { kind: 'noop'; result: { count: 0; changed: false } } | { kind: 'prepared'; prepared: OrganizePrepared };
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= limit;
const unique = (rows: { id: string }[]) => new Set(rows.map((row) => row.id)).size === rows.length;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const selectionRequest = (request: OrganizeRequest) => {
    const base = { requestId: request.requestId, taskIds: request.taskIds, taskRevisions: request.taskRevisions,
        status: request.draft.status === 'done' ? 'done' as const : 'next' as const };
    return request.source === 'project' ? { ...base, source: request.source, params: request.params }
        : { ...base, source: request.source, params: request.params };
};
const readRequest = (input: unknown, source: OrganizeSource): OrganizeRequest | null => {
    const request = detachReferenceBatchJson<OrganizeRequest>(input);
    return request && exact(request, ['requestId', 'source', 'taskIds', 'taskRevisions', 'draft', 'params'])
        && record(request.draft) && exact(request.draft, Object.keys(EMPTY_BULK_ORGANIZE_DRAFT))
        && readBulkOrganizeDraftShape(request.draft)
        && (request.draft.status !== 'waiting' || Boolean(request.draft.delegateWho.trim()))
        && readStatusBatchSelectionRequest(selectionRequest(request), source) ? request : null;
};
const offersChoices = (request: OrganizeRequest, scope: NativeReferenceTasksMoveScope): boolean => {
    const choice = (value: string, ids: string[]) => value === BULK_ORGANIZE_KEEP || value === BULK_ORGANIZE_NONE || ids.includes(value);
    return choice(request.draft.projectChoice, getBulkOrganizeProjectOptions(scope.projects.map(loadedReferenceBatchProject)).map(row => row.id))
        && choice(request.draft.areaChoice, getBulkOrganizeAreaOptions(scope.areas).map(row => row.id));
};

/** Every Inbox visibility row and picker option; destination members also reserve container order. */
export const tasksOrganizeScope = (request: OrganizeRequest,
    data: Pick<AppData, 'tasks' | 'projects' | 'sections' | 'areas' | 'settings'>): NativeReferenceTasksMoveScope => {
    const base = referenceTasksMoveScope(selectionRequest(request), data);
    const ids = new Set(base.tasks.map(row => row.id)); const sectionIds = new Set(base.sections.map(row => row.id));
    const sectionById = buildEntityMap(data.sections);
    const destination = request.draft.projectChoice;
    return { tasks: data.tasks.filter(row => ids.has(row.id) || row.projectId === destination
        || Boolean(row.sectionId && sectionById.get(row.sectionId)?.projectId === destination)),
    projects: data.projects, areas: data.areas,
    sections: data.sections.filter(row => sectionIds.has(row.id) || row.projectId === destination),
    settings: statusBatchSettings(data.settings, request.source) };
};
const updates = (request: OrganizeRequest, tasks: Task[]) => {
    const write = planBulkOrganize(request.taskIds, buildEntityMap(tasks), buildBulkOrganizeInput(request.draft));
    return write?.kind === 'update' ? write.updates : [];
};
const requiredDates = (request: OrganizeRequest, scope: NativeReferenceTasksMoveScope) =>
    [...new Set([...requiredReferenceBatchDates(scope), ...[request.draft.startDate, request.draft.dueDate, request.draft.reviewDate].filter(Boolean)])].sort();
const temporalContext = (prepared: Pick<OrganizePrepared, 'futureBoundary' | 'dates'>) =>
    ({ futureBoundary: prepared.futureBoundary, dates: new Map(prepared.dates.map(row => [row.value, row])) });

/** The RN planner/preflight/effects on raw BEFORE, with frozen time and identities. */
const tasksOrganizeEffect = (prepared: Pick<OrganizePrepared,
    'request' | 'scope' | 'deviceIdBefore' | 'deviceIdToInitialize' | 'updateAt' | 'futureBoundary' | 'dates' | 'recurrenceProjections' | 'allocatedIds'>,
    allocate = false): OrganizePrepared['effect'] | null => {
    const { request, scope } = prepared;
    const temporal = temporalContext(prepared);
    const tasks = scope.tasks.map(row => historyRowLoadProjection(row, prepared.updateAt, temporal));
    const projects = scope.projects.map(loadedReferenceBatchProject);
    const preflight = prepareTaskBatchUpdatesForStore({ updatesList: updates(request, tasks),
        state: { _tasksById: buildEntityMap(tasks), _projectsById: buildEntityMap(projects), _allProjects: projects,
            _allSections: scope.sections, _allAreas: scope.areas, settings: scope.settings, persistenceFailure: null },
        futureBoundary: prepared.futureBoundary, futureDates: temporal.dates, nowMs: Date.parse(prepared.updateAt) });
    if (!preflight.ok || preflight.optimisticRetryProjectIds.length) return null;
    let cursor = 0;
    const createId = () => {
        if (allocate) prepared.allocatedIds.push(generateUUID());
        const id = prepared.allocatedIds[cursor++];
        if (!id || !UUID.test(id)) throw new Error('Missing frozen identity');
        return id;
    };
    const planned = planTaskBatchUpdateEffects({ preparedUpdatesById: preflight.preparedUpdatesById,
        allTasks: tasks, allProjects: projects, allSections: scope.sections, now: prepared.updateAt,
        deviceId: prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, createId,
        recurrenceProjections: new Map(prepared.recurrenceProjections.map(row => [row.id, row.projection])) });
    if (cursor !== prepared.allocatedIds.length || new Set(prepared.allocatedIds).size !== prepared.allocatedIds.length
        || planned.tasks.length !== tasks.length + planned.createdTasks.length) return null;
    const pairs = <T extends { id: string }>(raw: T[], loaded: T[], after: T[]): { before: T; after: T }[] => {
        const loadedById = buildEntityMap(loaded); const afterById = buildEntityMap(after);
        return raw.flatMap(before => { const result = afterById.get(before.id);
            return !result || same(loadedById.get(before.id), result) ? [] : [{ before, after: result }]; });
    };
    return { tasks: pairs(scope.tasks, tasks, planned.tasks), createdTasks: planned.createdTasks,
        projects: pairs(scope.projects, projects, planned.projects), sections: pairs(scope.sections, scope.sections, planned.sections) };
};
export const readTasksOrganizeEnvelope = (input: unknown, source: OrganizeSource): OrganizeEnvelope | null => {
    const envelope = detachReferenceBatchJson<Record<string, unknown>>(input);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request, source); const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'scope', 'effect', 'deviceIdBefore', 'deviceIdToInitialize', 'updateAt',
        'preparedLocalDay', 'preparedOffsetMinutes', 'boundaryOffsetMinutes', 'futureBoundary', 'dates', 'recurrenceProjections', 'allocatedIds', 'result'])
        || raw.version !== 1 || !same(raw.request, request) || !record(raw.scope)
        || !exact(raw.scope, ['tasks', 'projects', 'sections', 'areas', 'settings'])
        || !Array.isArray(raw.scope.tasks) || !raw.scope.tasks.every(validReferenceBatchTask) || !unique(raw.scope.tasks)
        || !Array.isArray(raw.scope.projects) || !raw.scope.projects.every(validReferenceBatchProject) || !unique(raw.scope.projects)
        || !Array.isArray(raw.scope.sections) || !raw.scope.sections.every(row => record(row) && text(row.id, 500)
            && text(row.projectId, 500) && validSection(row, row.id, row.projectId)) || !unique(raw.scope.sections)
        || !Array.isArray(raw.scope.areas) || !raw.scope.areas.every(validReferenceBatchArea) || !unique(raw.scope.areas)
        || !record(raw.scope.settings) || !same(statusBatchSettings(raw.scope.settings, source), raw.scope.settings)
        || !record(raw.effect) || !exact(raw.effect, ['tasks', 'createdTasks', 'projects', 'sections'])
        || !Array.isArray(raw.effect.tasks) || !Array.isArray(raw.effect.createdTasks)
        || !Array.isArray(raw.effect.projects) || !Array.isArray(raw.effect.sections)
        || (raw.deviceIdBefore !== null && !text(raw.deviceIdBefore, 500))
        || (raw.deviceIdBefore === null ? typeof raw.deviceIdToInitialize !== 'string' || !UUID.test(raw.deviceIdToInitialize) : raw.deviceIdToInitialize !== null)
        || !iso(raw.updateAt) || !iso(raw.futureBoundary) || typeof raw.preparedLocalDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.preparedLocalDay)
        || !Number.isInteger(raw.preparedOffsetMinutes) || Math.abs(raw.preparedOffsetMinutes as number) > 840
        || !Number.isInteger(raw.boundaryOffsetMinutes) || Math.abs(raw.boundaryOffsetMinutes as number) > 840
        || !Array.isArray(raw.dates) || !raw.dates.every(validFrozenFocusDate)
        || !Array.isArray(raw.recurrenceProjections) || raw.recurrenceProjections.length !== request.taskIds.length
        || !raw.recurrenceProjections.every((row, index) => record(row) && exact(row, ['id', 'projection']) && row.id === request.taskIds[index]
            && validReferenceBatchRecurrenceProjection(row.projection) && (request.draft.status === 'done' || row.projection === null))
        || !Array.isArray(raw.allocatedIds) || !raw.allocatedIds.every(id => typeof id === 'string' && UUID.test(id))
        || new Set(raw.allocatedIds).size !== raw.allocatedIds.length
        || !record(raw.result) || !exact(raw.result, ['count', 'changed']) || raw.result.changed !== true
        || !Number.isInteger(raw.result.count) || (raw.result.count as number) < 1 || (raw.result.count as number) > request.taskIds.length) return null;
    try {
        const prepared = raw as unknown as OrganizePrepared;
        const expected = tasksOrganizeEffect(prepared);
        return offersChoices(request, prepared.scope) && statusBatchSourcesMatch(selectionRequest(request), prepared.scope, prepared.updateAt, temporalContext(prepared))
            && (prepared.scope.settings.deviceId ?? null) === prepared.deviceIdBefore
            && same(tasksOrganizeScope(request, prepared.scope), prepared.scope)
            && new Date(Date.parse(prepared.updateAt) - prepared.preparedOffsetMinutes * 60_000).toISOString().slice(0, 10) === prepared.preparedLocalDay
            && new Date(Date.parse(`${prepared.preparedLocalDay}T23:59:59.999Z`) + prepared.boundaryOffsetMinutes * 60_000).toISOString() === prepared.futureBoundary
            && same(requiredDates(request, prepared.scope), prepared.dates.map(row => row.value))
            && expected && same(expected, prepared.effect)
            && prepared.result.count === updates(request, prepared.scope.tasks.map(row => historyRowLoadProjection(row, prepared.updateAt, temporalContext(prepared)))).length
            && [...prepared.effect.tasks, ...prepared.effect.projects, ...prepared.effect.sections].every(pair => record(pair) && exact(pair, ['before', 'after']))
            ? envelope as OrganizeEnvelope : null;
    } catch { return null; }
};
export const tasksOrganizeAuthorityMatches = (prepared: OrganizePrepared, data: AppData): boolean => {
    const current = rawReferenceBatchScope(tasksOrganizeScope(prepared.request, data));
    return Boolean(current && same(current, prepared.scope) && offersChoices(prepared.request, current)
        && statusBatchSourcesMatch(selectionRequest(prepared.request), current, prepared.updateAt, temporalContext(prepared))
        && !data.tasks.some(row => prepared.allocatedIds.includes(row.id))
        && same(tasksOrganizeEffect({ ...prepared, scope: current }), prepared.effect));
};

export function createTasksOrganizeMethods(deps: {
    readiness: () => NativeHostResult<null>; save: () => Promise<NativeHostResult<null>>;
}, source: OrganizeSource) {
    const label = source === 'project' ? 'Project' : 'Inbox';
    const family = `${source}TasksOrganize`;
    const guardedAdapter = (): NativeHostResult<null> => {
        const adapter = getStorageAdapter();
        if (source === 'project' && !isNativeRequestReceiptDurable('projectTasksOrganize'))
            return fail('SAVE_FAILED', 'Project Organize receipt storage is unavailable');
        return adapter instanceof NativeReceiptSqliteAdapter && adapter.concurrentWritesGuarded
            ? { ok: true, value: null } : fail('SAVE_FAILED', `${label} Organize requires guarded canonical SQLite storage`);
    };
    const checkForeignKeyAuthority = async (adapter: ReturnType<typeof getStorageAdapter>): Promise<NativeHostResult<null>> => {
        if (getStorageAdapter() !== adapter) return fail('STALE_REVISION', `${label} Organize storage changed while reading`);
        if (!(adapter instanceof NativeReceiptSqliteAdapter) || !adapter.concurrentWritesGuarded)
            return fail('SAVE_FAILED', `${label} Organize requires guarded canonical SQLite storage`);
        const state = useTaskStore.getState();
        try {
            const invalid = await adapter.hasForeignKeyViolations();
            if (getStorageAdapter() !== adapter) return fail('STALE_REVISION', `${label} Organize storage changed while reading`);
            const current = useTaskStore.getState();
            if (current._allTasks !== state._allTasks || current._allProjects !== state._allProjects
                || current._allSections !== state._allSections || current._allAreas !== state._allAreas
                || current._allPeople !== state._allPeople || current.settings !== state.settings
                || current.lastDataChangeAt !== state.lastDataChangeAt)
                return fail('STALE_REVISION', `${label} Organize data changed while checking saved references`);
            return invalid ? fail('SAVE_FAILED', `Saved ${label} data has invalid container references`) : { ok: true, value: null };
        } catch { return fail('SAVE_FAILED', `Saved ${label} container references could not be checked`); }
    };
    const saves = createAreaSaveGuard(deps.save);
    let pending: { envelope: OrganizeEnvelope; adapter: ReturnType<typeof getStorageAdapter>;
        boundary: PreparedNativeSaveBoundary | undefined } | null = null;
    const payload = (envelope: OrganizeEnvelope): string => JSON.stringify([family, envelope], (_name, item) => record(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
    const checkAuthority = (envelope: OrganizeEnvelope, authority: PreparedAreaAuthority): NativeHostResult<null> => {
        const guarded = guardedAdapter(); if (!guarded.ok) return guarded;
        if (!referenceBatchSettingsReadable(authority.snapshot.settings)) return fail('SAVE_FAILED', `Saved ${label} settings JSON is unreadable`);
        try { return tasksOrganizeAuthorityMatches(envelope.prepared, authority.snapshot)
            ? { ok: true, value: null } : fail('STALE_REVISION', `${label} Organize selection, options or saved dependency context changed`); }
        catch { return fail('STALE_REVISION', `${label} Organize rules changed since preparation`); }
    };
    const apply = (envelope: OrganizeEnvelope, authority: PreparedAreaAuthority) => source === 'project'
        ? useTaskStore.getState().commitPreparedProjectTasksOrganize(envelope.prepared as NativeProjectTasksOrganizePrepared, authority)
        : useTaskStore.getState().commitPreparedInboxTasksOrganize(envelope.prepared as NativeInboxTasksOrganizePrepared, authority);
    const receipts = createNativeRequestReceipts({ save: async requestId => {
        const owned = pending;
        if (!owned || owned.envelope.request.requestId !== requestId) return fail('SAVE_FAILED', `${label} Organize has no owned raw save`);
        if (useTaskStore.getState().persistenceFailure) {
            if (!saves.mayApply(owned.envelope, owned.adapter)) return fail('SAVE_FAILED', `${label} Organize has an unrelated persistence failure`);
            const read = await readAreaDurableData(true, true); if (!read.ok) return read;
            if (read.value.adapter !== owned.adapter) return fail('STALE_REVISION', `${label} Organize storage changed before retry`);
            const foreignKeys = await checkForeignKeyAuthority(read.value.adapter); if (!foreignKeys.ok) return foreignKeys;
            const checked = checkAuthority(owned.envelope, read.value.authority); if (!checked.ok) return checked;
            const applied = await apply(owned.envelope, read.value.authority);
            if (!applied.success || applied.outcome !== 'applied') return fail('STALE_REVISION', applied.error ?? `${label} Organize retry was superseded`);
            owned.boundary = read.value.authority.saveBoundary;
        }
        const saved = await saves.finish(owned.envelope, owned.adapter, false, owned.boundary);
        if (saved.ok) pending = null;
        return saved;
    } });
    return {
        async prepareTasksOrganize(input: OrganizeRequest): Promise<NativeHostResult<OrganizePreparation>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const guarded = guardedAdapter(); if (!guarded.ok) return guarded;
            const request = readRequest(input, source);
            if (!request) return fail('INVALID_INPUT', `Select saved ${label} tasks with exact revisions, a complete Organize draft and list scope`);
            const memory = useTaskStore.getState(); const now = new Date();
            if (!statusBatchSourcesMatch(selectionRequest(request), { tasks: memory._allTasks, projects: memory._allProjects,
                sections: memory._allSections, areas: memory._allAreas, settings: memory.settings }, now.toISOString()))
                return fail('STALE_REVISION', `${label} selection changed since it was shown`);
            if (!offersChoices(request, { tasks: memory._allTasks, projects: memory._allProjects,
                sections: memory._allSections, areas: memory._allAreas, settings: memory.settings }))
                return fail('INVALID_INPUT', `${label} Organize destination is not offered`);
            const read = await readAreaDurableData(false, true); if (!read.ok) return read;
            const foreignKeys = await checkForeignKeyAuthority(read.value.adapter); if (!foreignKeys.ok) return foreignKeys;
            const data = read.value.authority.snapshot;
            if (!referenceBatchSettingsReadable(data.settings)) return fail('SAVE_FAILED', `Saved ${label} settings JSON is unreadable`);
            const scope = rawReferenceBatchScope(tasksOrganizeScope(request, data));
            if (!scope) return fail('SAVE_FAILED', `Saved ${label} raw JSON could not be bound safely`);
            if (!detachReferenceBatchValue(scope)) return fail('INVALID_INPUT', `${label} Organize witness is too large; select a smaller library`);
            if (!statusBatchSourcesMatch(selectionRequest(request), scope, now.toISOString()) || !offersChoices(request, scope))
                return fail('STALE_REVISION', `Saved ${label} selection or offered destinations changed`);
            const loaded = buildEntityMap(scope.tasks.map(row => historyRowLoadProjection(row, now.toISOString())));
            const count = updates(request, [...loaded.values()]).length;
            if (!count) return { ok: true, value: { kind: 'noop', result: { count: 0, changed: false } } };
            const end = new Date(now); end.setHours(23, 59, 59, 999); const device = ensureDeviceId(scope.settings);
            const base = { version: 1 as const, request, scope, deviceIdBefore: scope.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null, updateAt: now.toISOString(),
                preparedLocalDay: new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10),
                preparedOffsetMinutes: now.getTimezoneOffset(), boundaryOffsetMinutes: end.getTimezoneOffset(), futureBoundary: end.toISOString(),
                dates: projectFocusDateValues(requiredDates(request, scope)), recurrenceProjections: request.taskIds.map(id => ({ id,
                    projection: request.draft.status === 'done' ? projectNextRecurringTask(loaded.get(id)!, now.toISOString()) : null })),
                allocatedIds: [] as string[], result: { count, changed: true } };
            let effect;
            try {
                const fullScope = rawReferenceBatchScope({ tasks: data.tasks, projects: data.projects, sections: data.sections,
                    areas: data.areas, settings: statusBatchSettings(data.settings, request.source) });
                if (!fullScope) return fail('SAVE_FAILED', `Saved ${label} raw JSON could not be bound safely`);
                const first = tasksOrganizeEffect({ ...base, scope: fullScope, dates: projectFocusDateValues(requiredDates(request, fullScope)) }, true);
                effect = tasksOrganizeEffect(base);
                if (!same(first, effect) || data.tasks.some(row => base.allocatedIds.includes(row.id))) effect = null;
            } catch { effect = null; }
            const prepared = effect && detachReferenceBatchValue<OrganizePrepared>({ ...base, effect });
            return prepared && readTasksOrganizeEnvelope({ request, prepared }, source) ? { ok: true, value: { kind: 'prepared', prepared } }
                : fail('INVALID_INPUT', `${label} Organize cannot prepare these rows or its journal is too large; select fewer tasks`);
        },
        validatePreparedTasksOrganize(input: OrganizeEnvelope): NativeHostResult<NativeInboxTasksOrganizeResult> {
            const envelope = readTasksOrganizeEnvelope(input, source); return envelope ? { ok: true, value: envelope.prepared.result }
                : fail('INVALID_INPUT', `Prepared ${label} Organize is malformed`);
        },
        tasksOrganizeOutcome(input: OrganizeEnvelope): NativeHostResult<NativeInboxTasksOrganizeResult | null> {
            const envelope = readTasksOrganizeEnvelope(input, source);
            if (source === 'project' && !isNativeRequestReceiptDurable('projectTasksOrganize'))
                return fail('SAVE_FAILED', 'Project Organize receipt storage is unavailable');
            return envelope
                ? receipts.saved<NativeInboxTasksOrganizeResult>(envelope.request.requestId, payload(envelope)) ?? { ok: true, value: null }
                : fail('INVALID_INPUT', `Prepared ${label} Organize is malformed`);
        },
        async commitPreparedTasksOrganize(input: OrganizeEnvelope): Promise<NativeHostResult<NativeInboxTasksOrganizeResult>> {
            const envelope = readTasksOrganizeEnvelope(input, source); if (!envelope) return fail('INVALID_INPUT', `Prepared ${label} Organize is malformed`);
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const guarded = guardedAdapter(); if (!guarded.ok) return guarded;
            const boundPayload = payload(envelope); const saved = receipts.saved<NativeInboxTasksOrganizeResult>(envelope.request.requestId, boundPayload);
            if (saved) return saved.ok && !same(saved.value, envelope.prepared.result)
                ? fail('INVALID_INPUT', `Saved ${label} Organize result does not match its journal`) : saved;
            let prewriteFailure: NativeHostResult<never> | null = null;
            const notLanded = (message: string): NativeHostResult<never> => { prewriteFailure = fail('SAVE_FAILED', message);
                return { ok: false, error: { code: 'ACTION_FAILED', message } }; };
            const confirmed = await receipts.run(envelope.request.requestId, boundPayload, async () => {
                if (useTaskStore.getState().persistenceFailure) return notLanded(`${label} Organize has an unresolved persistence failure`);
                const read = await readAreaDurableData(false, true);
                if (!read.ok) return read.error.code === 'SAVE_FAILED' ? notLanded(read.error.message) : read;
                const foreignKeys = await checkForeignKeyAuthority(read.value.adapter);
                if (!foreignKeys.ok) return foreignKeys.error.code === 'SAVE_FAILED' ? notLanded(foreignKeys.error.message) : foreignKeys;
                const checked = checkAuthority(envelope, read.value.authority); if (!checked.ok) return checked;
                const applied = await apply(envelope, read.value.authority);
                if (!applied.success || applied.outcome !== 'applied') return fail('STALE_REVISION', applied.error ?? `${label} Organize conflicts with saved data`);
                pending = { envelope, adapter: read.value.adapter, boundary: read.value.authority.saveBoundary };
                return { ok: true, value: envelope.prepared.result };
            });
            if (prewriteFailure) return prewriteFailure;
            if (confirmed.ok && !same(confirmed.value, envelope.prepared.result)) return fail('INVALID_INPUT', `Saved ${label} Organize result does not match its journal`);
            if (confirmed.ok) {
                try { logInfo(`Native ${label} bulk Organize confirmed`, { scope: 'native-host', category: 'storage', ...(source === 'project' ? { force: true } : {}),
                    context: { releaseCheck: source === 'project' ? 'v1.3.8/ios-project-bulk-organize' : 'v1.3.5/ios-inbox-bulk-organize', count: confirmed.value.count, outcome: 'organized' } }); }
                catch { /* Diagnostics cannot invalidate a durable acknowledgment. */ }
            }
            return confirmed;
        },
    };
}
// Preserve the public Inbox signatures and old serialized reader; only the private engine admits Project.
export const inboxTasksOrganizeScope = (request: NativeInboxTasksOrganizeRequest,
    data: Pick<AppData, 'tasks' | 'projects' | 'sections' | 'areas' | 'settings'>): NativeReferenceTasksMoveScope => tasksOrganizeScope(request, data);
export const inboxTasksOrganizeEffect = (prepared: Pick<NativeInboxTasksOrganizePrepared,
    'request' | 'scope' | 'deviceIdBefore' | 'deviceIdToInitialize' | 'updateAt' | 'futureBoundary' | 'dates' | 'recurrenceProjections' | 'allocatedIds'>,
    allocate = false): NativeInboxTasksOrganizePrepared['effect'] | null => tasksOrganizeEffect(prepared, allocate);
export const readInboxTasksOrganizeEnvelope = (input: unknown): NativeInboxTasksOrganizeEnvelope | null =>
    readTasksOrganizeEnvelope(input, 'inbox') as NativeInboxTasksOrganizeEnvelope | null;
export const inboxTasksOrganizeAuthorityMatches = (prepared: NativeInboxTasksOrganizePrepared, data: AppData): boolean =>
    tasksOrganizeAuthorityMatches(prepared, data);
export function createInboxTasksOrganizeMethods(deps: Parameters<typeof createTasksOrganizeMethods>[0]) {
    const methods = createTasksOrganizeMethods(deps, 'inbox');
    return {
        prepareInboxTasksOrganize: (input: NativeInboxTasksOrganizeRequest) => methods.prepareTasksOrganize(input) as Promise<NativeHostResult<NativeInboxTasksOrganizePreparation>>,
        validatePreparedInboxTasksOrganize: (input: NativeInboxTasksOrganizeEnvelope) => methods.validatePreparedTasksOrganize(input),
        inboxTasksOrganizeOutcome: (input: NativeInboxTasksOrganizeEnvelope) => methods.tasksOrganizeOutcome(input),
        commitPreparedInboxTasksOrganize: (input: NativeInboxTasksOrganizeEnvelope) => methods.commitPreparedTasksOrganize(input),
    };
}
referenceBatchModules.inboxOrganize = input => {
    const prepared = input as NativeInboxTasksOrganizePrepared;
    return { validateEnvelope: () => Boolean(readInboxTasksOrganizeEnvelope({ request: prepared.request, prepared })),
        authorityMatches: data => inboxTasksOrganizeAuthorityMatches(prepared, data) };
};
