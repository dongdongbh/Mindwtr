import type { NativeHostResult } from './native-host-contract';
import type { AppData, Area, Project, Section, Task } from './types';
import type { PreparedAreaAuthority, PreparedAreaCreate, PreparedNativeSaveBoundary } from './store-types';
import type { NativeInboxTasksMoveParams } from './native-host-contract-inbox-bulk-status';
import type { NativeInboxTasksOrganizeRequest } from './native-host-contract-inbox-bulk-organize';
import { inboxTasksOrganizeScope } from './native-host-contract-inbox-bulk-organize';
import { exact, iso, record } from './native-host-contract-project-shared';
import { readBulkOrganizeDraftShape, type createBulkActionMethods } from './native-host-contract-bulk-actions';
import { BULK_ORGANIZE_KEEP, BULK_ORGANIZE_NONE, EMPTY_BULK_ORGANIZE_DRAFT,
    buildBulkOrganizeDialogModel, getBulkOrganizeAreaOptions, getBulkOrganizeProjectOptions, type BulkOrganizeDraft } from './task-list-bulk-actions';
import { DEFAULT_AREA_COLOR, DEFAULT_PROJECT_COLOR } from './color-constants';
import { buildNewProject } from './store-projects/project-actions';
import { planAreaAddition, selectAreaAdditionScope, areaAdditionEffect } from './store-projects/area-actions';
import { compareProjectsByPickerOrder, getProjectChoiceState } from './project-utils';
import { validSection } from './native-host-contract-project-section-rename';
import { validFrozenFocusDate } from './native-host-contract-task-focus';
import { createAreaSaveGuard, readAreaDurableData } from './native-host-contract-area-durable';
import { createNativeRequestReceipts, NativeReceiptSqliteAdapter } from './native-request-receipts';
import { taskEditValuesEqual as same } from './json-value-equality';
import { ensureDeviceId } from './store-helpers';
import { getStorageAdapter, useTaskStore } from './store';
import { projectFocusDateValues, type FocusDateProjection } from './task-utils';
import { logInfo } from './logger';
import { referenceBatchModules } from './store-reference-batch-modules';
import { detachReferenceBatchJson, detachReferenceBatchValue, readStatusBatchSelectionRequest,
    statusBatchSourcesMatch, statusBatchSettings, rawReferenceBatchScope, loadedReferenceBatchProject,
    referenceBatchSettingsReadable, requiredReferenceBatchDates, validReferenceBatchTask,
    validReferenceBatchProject, validReferenceBatchArea, type NativeReferenceTasksMoveScope } from './native-host-contract-reference-bulk-status';

export type NativeInboxOrganizeDestinationCreateRequest = {
    requestId: string; source: 'inbox'; kind: 'project' | 'area'; name: string;
    draft: BulkOrganizeDraft; offerRevision: string; taskIds: string[];
    taskRevisions: Record<string, string>; params: NativeInboxTasksMoveParams;
};
export type NativeInboxOrganizeDestinationCreateResult = { id: string; changed: true };
type Pair<T> = { before: T | null; after: T };
export type NativeInboxOrganizeDestinationCreatePrepared = {
    version: 1; request: NativeInboxOrganizeDestinationCreateRequest;
    scope: { inbox: NativeReferenceTasksMoveScope; allProjects: Project[]; allAreas: Area[];
        restoration: PreparedAreaCreate['scope'] | null; defaultProjectFlowMode: string | null };
    resolution: { kind: 'freshProject' | 'freshArea' | 'restoreArea'; id: string };
    effect: { tasks: Pair<Task>[]; projects: Pair<Project>[]; sections: Pair<Section>[]; areas: Pair<Area>[] };
    deviceIdBefore: string | null; deviceIdToInitialize: string | null;
    preparedAt: string; updateAt: string; preparedLocalDay: string; preparedOffsetMinutes: number;
    boundaryOffsetMinutes: number; futureBoundary: string; dates: FocusDateProjection[];
    result: NativeInboxOrganizeDestinationCreateResult;
};
export type NativeInboxOrganizeDestinationCreateEnvelope = { request: NativeInboxOrganizeDestinationCreateRequest;
    prepared: NativeInboxOrganizeDestinationCreatePrepared };
export type NativeInboxOrganizeDestinationCreatePreparation = { kind: 'prepared'; prepared: NativeInboxOrganizeDestinationCreatePrepared };
type Request = NativeInboxOrganizeDestinationCreateRequest;
type Prepared = NativeInboxOrganizeDestinationCreatePrepared;
type Envelope = NativeInboxOrganizeDestinationCreateEnvelope;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && Boolean(v.trim()) && v.length <= max;
const unique = (rows: { id: string }[]) => new Set(rows.map(row => row.id)).size === rows.length;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const selectionRequest = (r: Request) => ({ requestId: r.requestId, source: r.source, taskIds: r.taskIds,
    taskRevisions: r.taskRevisions, params: r.params, status: 'next' as const });
const scopeRequest = (r: Request): NativeInboxTasksOrganizeRequest => ({ requestId: r.requestId, source: r.source,
    taskIds: r.taskIds, taskRevisions: r.taskRevisions, params: r.params,
    draft: { ...r.draft, status: BULK_ORGANIZE_KEEP } });
const readRequest = (value: unknown): Request | null => {
    const r = detachReferenceBatchJson<Request>(value);
    return r && exact(r, ['requestId', 'source', 'kind', 'name', 'draft', 'offerRevision', 'taskIds', 'taskRevisions', 'params'])
        && (r.kind === 'project' || r.kind === 'area') && text(r.name, 100_000) && r.name === r.name.trim()
        && text(r.offerRevision, 100_000) && record(r.draft) && exact(r.draft, Object.keys(EMPTY_BULK_ORGANIZE_DRAFT))
        && readBulkOrganizeDraftShape(r.draft) && readStatusBatchSelectionRequest(selectionRequest(r), 'inbox') ? r : null;
};
const normalized = (name: string) => name.trim().toLowerCase();
const restoreTarget = (r: Request, areas: Area[]) => r.kind === 'area'
    ? areas.find(area => area.deletedAt && normalized(area.name) === normalized(r.name)) ?? null : null;
const rowUnion = <T extends { id: string }>(first: T[], second: T[]): T[] | null => {
    const byId = new Map(first.map(row => [row.id, row]));
    for (const row of second) { const prior = byId.get(row.id); if (prior && !same(prior, row)) return null; byId.set(row.id, row); }
    return [...byId.values()];
};
const scopeData = (s: Prepared['scope']): Pick<AppData, 'tasks' | 'projects' | 'sections' | 'areas' | 'settings'> | null => {
    const tasks = rowUnion(s.inbox.tasks, s.restoration?.tasks ?? []);
    const sections = rowUnion(s.inbox.sections, s.restoration?.sections ?? []);
    return tasks && sections ? { tasks, sections, projects: s.allProjects, areas: s.allAreas,
        settings: { ...s.inbox.settings, gtd: { ...s.inbox.settings.gtd,
            ...(s.defaultProjectFlowMode === null ? {} : { defaultProjectFlowMode: s.defaultProjectFlowMode as 'sequential' | 'parallel' }) } } } : null;
};
const rawScope = (r: Request, data: Pick<AppData, 'tasks' | 'projects' | 'sections' | 'areas' | 'settings'>): Prepared['scope'] | null => {
    const all = rawReferenceBatchScope({ tasks: data.tasks, projects: data.projects, sections: data.sections,
        areas: data.areas, settings: statusBatchSettings(data.settings, 'inbox') });
    const inbox = rawReferenceBatchScope(inboxTasksOrganizeScope(scopeRequest(r), data));
    if (!all || !inbox) return null;
    const target = restoreTarget(r, all.areas);
    return { inbox, allProjects: all.projects, allAreas: all.areas,
        restoration: target ? selectAreaAdditionScope(all, target) : null,
        defaultProjectFlowMode: data.settings.gtd?.defaultProjectFlowMode ?? null };
};
const offersCreate = (r: Request, scope: Prepared['scope']): boolean => {
    const projects = getBulkOrganizeProjectOptions(scope.allProjects.map(loadedReferenceBatchProject));
    const areas = getBulkOrganizeAreaOptions(scope.allAreas);
    const offered = (id: string, rows: { id: string }[]) => id === BULK_ORGANIZE_KEEP || id === BULK_ORGANIZE_NONE || rows.some(row => row.id === id);
    if (!offered(r.draft.projectChoice, projects) || !offered(r.draft.areaChoice, areas)) return false;
    if (r.kind === 'area' && buildBulkOrganizeDialogModel({ draft: r.draft, projects, areas,
        selectedCount: r.taskIds.length, t: value => value }).area.disabled) return false;
    return r.kind === 'project'
        ? !getProjectChoiceState([...projects].sort(compareProjectsByPickerOrder), r.name,
            [...scope.allProjects.map(loadedReferenceBatchProject)].sort(compareProjectsByPickerOrder)).exactMatch
        : !areas.some(area => area.name.toLowerCase() === normalized(r.name));
};
export const inboxOrganizeDestinationCreateEffect = (p: Omit<Prepared, 'effect' | 'result' | 'resolution'>):
    Pick<Prepared, 'effect' | 'result' | 'resolution'> | null => {
    const { request: r, scope } = p; const data = scopeData(scope);
    if (!data || !offersCreate(r, scope)) return null;
    const device = p.deviceIdBefore ?? p.deviceIdToInitialize!;
    if (r.kind === 'project') {
        if (scope.allProjects.some(row => row.id === r.requestId)) return null;
        const areaId = [BULK_ORGANIZE_KEEP, BULK_ORGANIZE_NONE].includes(r.draft.areaChoice) ? undefined : r.draft.areaChoice;
        const project = buildNewProject({ title: r.name, color: DEFAULT_PROJECT_COLOR,
            initialProps: { id: r.requestId, ...(areaId ? { areaId } : {}) }, existingProjects: scope.allProjects,
            existingAreas: scope.allAreas, settings: data.settings, deviceId: device, now: p.preparedAt, id: r.requestId });
        return { resolution: { kind: 'freshProject', id: project.id }, result: { id: project.id, changed: true },
            effect: { tasks: [], sections: [], areas: [], projects: [{ before: null, after: project }] } };
    }
    if (scope.allAreas.some(row => row.id === r.requestId)) return null;
    const planned = planAreaAddition(data, r.name, { color: DEFAULT_AREA_COLOR }, r.requestId, device, p.preparedAt, p.updateAt);
    if (!planned || planned.kind === 'live') return null;
    const before = scope.restoration ?? { area: null, projects: [], sections: [], tasks: [] };
    const changes = areaAdditionEffect(before, planned.rows, planned.area.id);
    return { resolution: { kind: planned.kind === 'fresh' ? 'freshArea' : 'restoreArea', id: planned.area.id },
        result: { id: planned.area.id, changed: true }, effect: { tasks: changes.tasks, projects: changes.projects,
            sections: changes.sections, areas: [changes.area] } };
};
const requiredDates = (scope: Prepared['scope']) => requiredReferenceBatchDates(scope.inbox);
const selectedMatch = (p: Pick<Prepared, 'request' | 'scope' | 'preparedAt' | 'futureBoundary' | 'dates'>) =>
    statusBatchSourcesMatch(selectionRequest(p.request), p.scope.inbox, p.preparedAt,
        { futureBoundary: p.futureBoundary, dates: new Map(p.dates.map(row => [row.value, row])) });
const validScope = (s: unknown): s is Prepared['scope'] => {
    if (!record(s) || !exact(s, ['inbox', 'allProjects', 'allAreas', 'restoration', 'defaultProjectFlowMode'])
        || !record(s.inbox) || !exact(s.inbox, ['tasks', 'projects', 'sections', 'areas', 'settings'])
        || !record(s.inbox.settings) || !same(statusBatchSettings(s.inbox.settings, 'inbox'), s.inbox.settings)
        || !(s.defaultProjectFlowMode === null || typeof s.defaultProjectFlowMode === 'string')) return false;
    const rows = (value: unknown, valid: (row: unknown) => boolean): boolean => Array.isArray(value) && value.every(valid) && unique(value);
    const section = (row: unknown) => record(row) && text(row.id, 500) && text(row.projectId, 500) && validSection(row, row.id, row.projectId);
    if (!rows(s.inbox.tasks, validReferenceBatchTask) || !rows(s.inbox.projects, validReferenceBatchProject)
        || !rows(s.inbox.sections, section) || !rows(s.inbox.areas, validReferenceBatchArea)
        || !rows(s.allProjects, validReferenceBatchProject) || !rows(s.allAreas, validReferenceBatchArea)
        || !same(s.inbox.projects, s.allProjects) || !same(s.inbox.areas, s.allAreas)) return false;
    const restore = s.restoration;
    return restore === null || record(restore) && exact(restore, ['area', 'projects', 'sections', 'tasks'])
        && validReferenceBatchArea(restore.area) && Boolean(restore.area.deletedAt)
        && rows(restore.projects, validReferenceBatchProject) && rows(restore.sections, section) && rows(restore.tasks, validReferenceBatchTask);
};
// Inbox and restoration are independently ordered saved witnesses. Their overlapping rows
// must agree, but an Inbox-first union cannot reconstruct the original restoration order.
const scopeConsistent = (r: Request, scope: Prepared['scope'], data: NonNullable<ReturnType<typeof scopeData>>): boolean => {
    const inbox = rawReferenceBatchScope(inboxTasksOrganizeScope(scopeRequest(r), data));
    if (!same(inbox, scope.inbox)) return false;
    const target = restoreTarget(r, scope.allAreas);
    if (!target) return scope.restoration === null;
    if (!scope.restoration) return false;
    const tasks = rowUnion(scope.restoration.tasks, scope.inbox.tasks);
    const sections = rowUnion(scope.restoration.sections, scope.inbox.sections);
    return Boolean(tasks && sections && same(selectAreaAdditionScope({ areas: scope.allAreas,
        projects: scope.allProjects, tasks, sections }, target), scope.restoration));
};
export const readInboxOrganizeDestinationCreateEnvelope = (input: unknown): Envelope | null => {
    const e = detachReferenceBatchJson<Envelope>(input); if (!e || !exact(e, ['request', 'prepared']) || !record(e.prepared)) return null;
    const r = readRequest(e.request); const p = e.prepared;
    if (!r || !exact(p, ['version', 'request', 'scope', 'resolution', 'effect', 'deviceIdBefore', 'deviceIdToInitialize',
        'preparedAt', 'updateAt', 'preparedLocalDay', 'preparedOffsetMinutes', 'boundaryOffsetMinutes', 'futureBoundary', 'dates', 'result'])
        || p.version !== 1 || !same(p.request, r) || !validScope(p.scope)
        || (p.deviceIdBefore !== null && !text(p.deviceIdBefore, 500))
        || (p.deviceIdBefore === null ? typeof p.deviceIdToInitialize !== 'string' || !UUID.test(p.deviceIdToInitialize) : p.deviceIdToInitialize !== null)
        || !iso(p.preparedAt) || !iso(p.updateAt) || !iso(p.futureBoundary) || Date.parse(p.updateAt) < Date.parse(p.preparedAt)
        || !/^\d{4}-\d{2}-\d{2}$/.test(p.preparedLocalDay) || !Number.isInteger(p.preparedOffsetMinutes) || Math.abs(p.preparedOffsetMinutes) > 840
        || !Number.isInteger(p.boundaryOffsetMinutes) || Math.abs(p.boundaryOffsetMinutes) > 840
        || !Array.isArray(p.dates) || !p.dates.every(validFrozenFocusDate)) return null;
    try {
        const data = scopeData(p.scope); const expected = inboxOrganizeDestinationCreateEffect(p);
        return data && scopeConsistent(r, p.scope, data) && selectedMatch(p)
            && (p.scope.inbox.settings.deviceId ?? null) === p.deviceIdBefore
            && same(requiredDates(p.scope), p.dates.map(row => row.value))
            && new Date(Date.parse(p.preparedAt) - p.preparedOffsetMinutes * 60_000).toISOString().slice(0, 10) === p.preparedLocalDay
            && new Date(Date.parse(p.preparedLocalDay + 'T23:59:59.999Z') + p.boundaryOffsetMinutes * 60_000).toISOString() === p.futureBoundary
            && expected && same(p.resolution, expected.resolution) && same(p.effect, expected.effect) && same(p.result, expected.result)
            ? e : null;
    } catch { return null; }
};
export const inboxOrganizeDestinationCreateAuthorityMatches = (p: Prepared, data: AppData): boolean => {
    const current = rawScope(p.request, data);
    return Boolean(current && same(current, p.scope) && selectedMatch({ ...p, scope: current })
        && same(inboxOrganizeDestinationCreateEffect({ ...p, scope: current }), { resolution: p.resolution, effect: p.effect, result: p.result }));
};

export function createInboxOrganizeDestinationCreateMethods(deps: {
    readiness: () => NativeHostResult<null>; save: () => Promise<NativeHostResult<null>>;
    getBulkActions: ReturnType<typeof createBulkActionMethods>['getBulkActions'];
}) {
    const guardedAdapter = (): NativeHostResult<null> => {
        const adapter = getStorageAdapter();
        return adapter instanceof NativeReceiptSqliteAdapter && adapter.concurrentWritesGuarded
            ? { ok: true, value: null } : fail('SAVE_FAILED', 'Inbox Organize destination creation requires guarded canonical SQLite storage');
    };
    const checkForeignKeyAuthority = async (adapter: ReturnType<typeof getStorageAdapter>): Promise<NativeHostResult<null>> => {
        if (getStorageAdapter() !== adapter) return fail('STALE_REVISION', 'Inbox Organize destination creation storage changed while reading');
        if (!(adapter instanceof NativeReceiptSqliteAdapter) || !adapter.concurrentWritesGuarded)
            return fail('SAVE_FAILED', 'Inbox Organize destination creation requires guarded canonical SQLite storage');
        try {
            const invalid = await adapter.hasForeignKeyViolations();
            if (getStorageAdapter() !== adapter) return fail('STALE_REVISION', 'Inbox Organize destination creation storage changed while reading');
            return invalid ? fail('SAVE_FAILED', 'Saved Inbox data has invalid container references') : { ok: true, value: null };
        } catch { return fail('SAVE_FAILED', 'Saved Inbox container references could not be checked'); }
    };
    const saves = createAreaSaveGuard(deps.save);
    let pending: { envelope: Envelope; adapter: ReturnType<typeof getStorageAdapter>;
        boundary: PreparedNativeSaveBoundary | undefined } | null = null;
    const payload = (envelope: Envelope): string => JSON.stringify(['inboxOrganizeDestinationCreate', envelope], (_name, item) => record(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
    const checkAuthority = (envelope: Envelope, authority: PreparedAreaAuthority): NativeHostResult<null> => {
        const guarded = guardedAdapter(); if (!guarded.ok) return guarded;
        if (!referenceBatchSettingsReadable(authority.snapshot.settings)) return fail('SAVE_FAILED', 'Saved Inbox settings JSON is unreadable');
        try { return inboxOrganizeDestinationCreateAuthorityMatches(envelope.prepared, authority.snapshot)
            ? { ok: true, value: null } : fail('STALE_REVISION', 'Inbox Organize destination creation selection, options or saved dependency context changed'); }
        catch { return fail('STALE_REVISION', 'Inbox Organize destination creation rules changed since preparation'); }
    };
    const apply = (envelope: Envelope, authority: PreparedAreaAuthority) =>
        useTaskStore.getState().commitPreparedInboxOrganizeDestinationCreate(envelope.prepared, authority);
    const receipts = createNativeRequestReceipts({ save: async requestId => {
        const owned = pending;
        if (!owned || owned.envelope.request.requestId !== requestId) return fail('SAVE_FAILED', 'Inbox Organize destination creation has no owned raw save');
        if (useTaskStore.getState().persistenceFailure) {
            if (!saves.mayApply(owned.envelope, owned.adapter)) return fail('SAVE_FAILED', 'Inbox Organize destination creation has an unrelated persistence failure');
            const read = await readAreaDurableData(true, true); if (!read.ok) return read;
            if (read.value.adapter !== owned.adapter) return fail('STALE_REVISION', 'Inbox Organize destination creation storage changed before retry');
            const foreignKeys = await checkForeignKeyAuthority(read.value.adapter); if (!foreignKeys.ok) return foreignKeys;
            const checked = checkAuthority(owned.envelope, read.value.authority); if (!checked.ok) return checked;
            const applied = await apply(owned.envelope, read.value.authority);
            if (!applied.success || applied.outcome !== 'applied') return fail('STALE_REVISION', applied.error ?? 'Inbox Organize destination creation retry was superseded');
            owned.boundary = read.value.authority.saveBoundary;
        }
        const saved = await saves.finish(owned.envelope, owned.adapter, false, owned.boundary);
        if (saved.ok) pending = null;
        return saved;
    } });
    const offeredNow = (request: Request): NativeHostResult<null> => {
        const offered = deps.getBulkActions({ list: 'inbox', params: request.params, taskIds: request.taskIds,
            organize: { draft: request.draft }, picker: { kind: request.kind, query: request.name, offset: 0, limit: 1 } });
        if (!offered.ok) return offered;
        const view = offered.value;
        if (view.revision !== request.offerRevision || !same(view.selectedIds, request.taskIds)
            || !same(view.taskRevisions, request.taskRevisions)) return fail('STALE_REVISION', 'Inbox creation offer or selection changed');
        if (request.kind === 'area' && view.organize?.area.disabled)
            return fail('INVALID_INPUT', 'Area creation is disabled while a Project is selected');
        return view.picker?.create?.name === request.name && view.picker.submit && 'create' in view.picker.submit
            && view.picker.submit.create === request.name ? { ok: true, value: null }
            : fail('INVALID_INPUT', 'Choose the existing picker option instead of creating it');
    };
    return {
        async prepareInboxOrganizeDestinationCreate(input: Request): Promise<NativeHostResult<NativeInboxOrganizeDestinationCreatePreparation>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const guarded = guardedAdapter(); if (!guarded.ok) return guarded;
            const request = readRequest(input); if (!request) return fail('INVALID_INPUT', 'A complete Inbox destination creation request is required');
            const offered = offeredNow(request); if (!offered.ok) return offered;
            const now = new Date(); const end = new Date(now); end.setHours(23, 59, 59, 999);
            const read = await readAreaDurableData(false, true); if (!read.ok) return read;
            const foreignKeys = await checkForeignKeyAuthority(read.value.adapter); if (!foreignKeys.ok) return foreignKeys;
            if (!referenceBatchSettingsReadable(read.value.authority.snapshot.settings)) return fail('SAVE_FAILED', 'Saved Inbox settings JSON is unreadable');
            const scope = rawScope(request, read.value.authority.snapshot);
            if (!scope) return fail('SAVE_FAILED', 'Saved Inbox creation context cannot be read');
            if (!detachReferenceBatchValue(scope)) return fail('INVALID_INPUT', 'Inbox creation witness exceeds the bounded journal');
            const rechecked = offeredNow(request); if (!rechecked.ok) return rechecked;
            const device = ensureDeviceId(scope.inbox.settings);
            const base = { version: 1 as const, request, scope, deviceIdBefore: scope.inbox.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null, preparedAt: now.toISOString(), updateAt: now.toISOString(),
                preparedLocalDay: new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10),
                preparedOffsetMinutes: now.getTimezoneOffset(), boundaryOffsetMinutes: end.getTimezoneOffset(), futureBoundary: end.toISOString(),
                dates: projectFocusDateValues(requiredDates(scope)) };
            const effect = inboxOrganizeDestinationCreateEffect(base);
            const prepared = effect && detachReferenceBatchValue<Prepared>({ ...base, ...effect });
            return prepared && readInboxOrganizeDestinationCreateEnvelope({ request, prepared })
                ? { ok: true, value: { kind: 'prepared', prepared } }
                : fail('STALE_REVISION', 'Saved Inbox selection or destination creation context changed');
        },
        validatePreparedInboxOrganizeDestinationCreate(input: Envelope): NativeHostResult<NativeInboxOrganizeDestinationCreateResult> {
            const e = readInboxOrganizeDestinationCreateEnvelope(input);
            return e ? { ok: true, value: e.prepared.result } : fail('INVALID_INPUT', 'Prepared Inbox destination creation is malformed');
        },
        inboxOrganizeDestinationCreateOutcome(input: Envelope): NativeHostResult<NativeInboxOrganizeDestinationCreateResult | null> {
            const e = readInboxOrganizeDestinationCreateEnvelope(input);
            return e ? receipts.saved<NativeInboxOrganizeDestinationCreateResult>(e.request.requestId, payload(e)) ?? { ok: true, value: null }
                : fail('INVALID_INPUT', 'Prepared Inbox destination creation is malformed');
        },
        async commitPreparedInboxOrganizeDestinationCreate(input: Envelope): Promise<NativeHostResult<NativeInboxOrganizeDestinationCreateResult>> {
            const envelope = readInboxOrganizeDestinationCreateEnvelope(input); if (!envelope) return fail('INVALID_INPUT', 'Prepared Inbox Organize destination creation is malformed');
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const guarded = guardedAdapter(); if (!guarded.ok) return guarded;
            const boundPayload = payload(envelope); const saved = receipts.saved<NativeInboxOrganizeDestinationCreateResult>(envelope.request.requestId, boundPayload);
            if (saved) return saved.ok && !same(saved.value, envelope.prepared.result)
                ? fail('INVALID_INPUT', 'Saved Inbox Organize destination creation result does not match its journal') : saved;
            let prewriteFailure: NativeHostResult<never> | null = null;
            const notLanded = (message: string): NativeHostResult<never> => { prewriteFailure = fail('SAVE_FAILED', message);
                return { ok: false, error: { code: 'ACTION_FAILED', message } }; };
            const confirmed = await receipts.run(envelope.request.requestId, boundPayload, async () => {
                if (useTaskStore.getState().persistenceFailure) return notLanded('Inbox Organize destination creation has an unresolved persistence failure');
                const read = await readAreaDurableData(false, true);
                if (!read.ok) return read.error.code === 'SAVE_FAILED' ? notLanded(read.error.message) : read;
                const foreignKeys = await checkForeignKeyAuthority(read.value.adapter);
                if (!foreignKeys.ok) return foreignKeys.error.code === 'SAVE_FAILED' ? notLanded(foreignKeys.error.message) : foreignKeys;
                const checked = checkAuthority(envelope, read.value.authority); if (!checked.ok) return checked;
                const applied = await apply(envelope, read.value.authority);
                if (!applied.success || applied.outcome !== 'applied') return fail('STALE_REVISION', applied.error ?? 'Inbox Organize destination creation conflicts with saved data');
                pending = { envelope, adapter: read.value.adapter, boundary: read.value.authority.saveBoundary };
                return { ok: true, value: envelope.prepared.result };
            });
            if (prewriteFailure) return prewriteFailure;
            if (confirmed.ok && !same(confirmed.value, envelope.prepared.result)) return fail('INVALID_INPUT', 'Saved Inbox Organize destination creation result does not match its journal');
            if (confirmed.ok) {
                try { logInfo('Native Inbox Organize destination confirmed', { scope: 'native-host', category: 'storage',
                    context: { releaseCheck: 'v1.3.5/ios-inbox-organize-stable-offer', kind: envelope.request.kind, outcome: 'saved' } }); }
                catch { /* Diagnostics cannot invalidate a durable acknowledgment. */ }
            }
            return confirmed;
        },
    };
}
referenceBatchModules.inboxOrganizeCreate = input => {
    const prepared = input as Prepared;
    return { validateEnvelope: () => Boolean(readInboxOrganizeDestinationCreateEnvelope({ request: prepared.request, prepared })),
        authorityMatches: data => inboxOrganizeDestinationCreateAuthorityMatches(prepared, data) };
};
