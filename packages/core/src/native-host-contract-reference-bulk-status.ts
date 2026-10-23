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
import { createNativeRequestReceipts, NativeReceiptSqliteAdapter, taskRevisionOf } from './native-request-receipts';
import { taskEditValuesEqual } from './json-value-equality';
import { buildEntityMap, ensureDeviceId } from './store-helpers';
import { planTaskBatchUpdateEffects, prepareTaskBatchUpdatesForStore } from './store-tasks';
import { getStorageAdapter, useTaskStore } from './store';
import { normalizeProjectLifecycleFields } from './project-status';
import { isProjectedRecurringTaskId, projectNextRecurringTask, type RecurrenceProjection } from './recurrence';
import { projectFocusDateValues, type FocusDateProjection } from './task-utils';
import { logInfo } from './logger';
import { referenceBatchModules } from './store-reference-batch-modules';
import { getBulkMoveStatusOptions } from './task-list-bulk-actions';
import { isStatusListTaskReadOnly } from './menu-views-model';
import { generateUUID } from './uuid';
import { rawReadAreaSnapshot, rawReadProjectSnapshot, rawReadSettingsJson, rawReadTaskSnapshot } from './sqlite-raw-snapshot';
import { resolveAreaFilterSelection } from './area-filter';
import { buildStatusListFilterOptions, buildStatusListModel, REFERENCE_LIST_DEFAULT_GROUP_BY,
    selectStatusListTasks, TASK_LIST_GROUP_OPTIONS } from './menu-views-model';
import { isFoldIdList, readFilterState } from './native-host-contract-menu-views';
import { resolveListFilterState, type ListFilterState } from './list-filter-state';
import { projectFromSqliteRow, projectToSqliteRow, PROJECT_SQLITE_COLUMNS } from './project-sync-schema';
import { normalizeRelativeStartOffset } from './task-relative-start';
import type { NativeInboxTasksMoveRequest, NativeInboxTasksMovePrepared } from './native-host-contract-inbox-bulk-status';
import type { TaskGroupBy } from './task-group-sections';
import type { TaskLoadTemporalContext } from './task-status';

export type NativeReferenceTasksMoveStatus = 'inbox' | 'next' | 'waiting' | 'someday' | 'done';
export type NativeReferenceTasksMoveParams = { groupBy?: TaskGroupBy; includeArchivedProjects?: boolean;
    collapsedGroupIds?: string[]; filters?: Partial<ListFilterState> };
export type NativeReferenceTasksMoveRequest = { requestId: string; taskIds: string[];
    taskRevisions: Record<string, string>; status: NativeReferenceTasksMoveStatus; params: NativeReferenceTasksMoveParams };
export type NativeReferenceTasksMoveResult = { count: number; status: NativeReferenceTasksMoveStatus };
export type NativeReferenceTasksMoveScope = { tasks: Task[]; projects: Project[]; sections: Section[];
    areas: Area[]; settings: AppData['settings'] };
export type NativeReferenceTasksMovePrepared = {
    version: 1; request: NativeReferenceTasksMoveRequest; scope: NativeReferenceTasksMoveScope;
    effect: { tasks: { before: Task; after: Task }[]; createdTasks: Task[];
        projects: { before: Project; after: Project }[]; sections: { before: Section; after: Section }[] };
    deviceIdBefore: string | null; deviceIdToInitialize: string | null;
    updateAt: string; preparedLocalDay: string; preparedOffsetMinutes: number;
    boundaryOffsetMinutes: number; futureBoundary: string; dates: FocusDateProjection[];
    recurrenceProjections: { id: string; projection: RecurrenceProjection | null }[];
    allocatedIds: string[]; result: NativeReferenceTasksMoveResult;
};
export type NativeReferenceTasksMoveEnvelope = { request: NativeReferenceTasksMoveRequest; prepared: NativeReferenceTasksMovePrepared };
export type NativeReferenceTasksMovePreparation = { kind: 'prepared'; prepared: NativeReferenceTasksMovePrepared };

type MoveSource = 'reference' | 'inbox';
type MoveRequest = NativeReferenceTasksMoveRequest | NativeInboxTasksMoveRequest;
type MovePrepared = Omit<NativeReferenceTasksMovePrepared, 'request' | 'result'> & {
    request: MoveRequest; result: { count: number; status: MoveRequest['status'] };
};
type MoveEnvelope = { request: MoveRequest; prepared: MovePrepared };
const sourceOf = (request: MoveRequest): MoveSource => 'source' in request ? request.source : 'reference';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const same = taskEditValuesEqual;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'TASK_NOT_FOUND' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const text = (value: unknown, limit: number): value is string =>
    typeof value === 'string' && Boolean(value.trim()) && value.length <= limit;
const unique = (rows: { id: string }[]) => new Set(rows.map((row) => row.id)).size === rows.length;
const canonicalPayload = (value: unknown): string => JSON.stringify(value, (_name, item) => record(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);

// The existing bounded JSON rules, with a narrow exception for the public
// revision dictionary: it can contain one entry per selected ID, not only128.
const detach = <T>(value: unknown): T | null => {
    const valid = (item: unknown, depth: number, path: string): boolean => {
        if (depth > 24) return false;
        if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
        if (typeof item === 'number') return Number.isFinite(item);
        if (Array.isArray(item)) return item.length <= 100_000 && item.every((part) => valid(part, depth + 1, `${path}[]`));
        const revisions = path === 'taskRevisions' || path === 'request.taskRevisions' || path === 'prepared.request.taskRevisions';
        return record(item) && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null)
            && Object.keys(item).length <= (revisions ? 10_000 : 128)
            && Object.entries(item).every(([name, part]) => (revisions || !['__proto__', 'constructor', 'prototype'].includes(name))
                && valid(part, depth + 1, path ? `${path}.${name}` : name));
    };
    if (!isNativeJsonWithinBytes(value) || !valid(value, 0, '')) return null;
    return JSON.parse(JSON.stringify(value)) as T;
};
const jsonSafe = <T>(value: unknown): T | null => {
    try { return detach<T>(JSON.parse(JSON.stringify(value))); } catch { return null; }
};
const readMoveRequest = (input: unknown, source: MoveSource): MoveRequest | null => {
    const request = detach<Record<string, unknown>>(input);
    if (!request || !exact(request, ['requestId', 'taskIds', 'taskRevisions', 'status', 'params', ...(source === 'inbox' ? ['source'] : [])])
        || (source === 'inbox' && request.source !== 'inbox')
        || typeof request.requestId !== 'string' || !UUID.test(request.requestId)
        || !Array.isArray(request.taskIds) || !request.taskIds.length || request.taskIds.length > 10_000
        || !request.taskIds.every((id) => text(id, 500)) || new Set(request.taskIds).size !== request.taskIds.length
        || !record(request.taskRevisions) || !exact(request.taskRevisions, request.taskIds)
        || !Object.values(request.taskRevisions).every((revision) => text(revision, 200))
        || !getBulkMoveStatusOptions(source).includes(request.status as TaskStatus)
        || !record(request.params) || Object.keys(request.params).some((name) =>
            !(source === 'inbox' ? ['groupBy', 'collapsedGroupIds', 'filters'] : ['groupBy', 'includeArchivedProjects', 'collapsedGroupIds', 'filters']).includes(name))
        || (request.params.groupBy !== undefined && !(TASK_LIST_GROUP_OPTIONS as readonly string[]).includes(request.params.groupBy as string))
        || (request.params.includeArchivedProjects !== undefined && typeof request.params.includeArchivedProjects !== 'boolean')
        || (request.params.collapsedGroupIds !== undefined && !isFoldIdList(request.params.collapsedGroupIds))
        || !readFilterState(request.params.filters)) return null;
    return request as MoveRequest;
};
const readRequest = (input: unknown): NativeReferenceTasksMoveRequest | null => readMoveRequest(input, 'reference') as NativeReferenceTasksMoveRequest | null;
const validTask = (row: unknown): row is Task => record(row) && text(row.id, 500)
    && validRawTask({ ...row, tags: row.tags ?? [], contexts: row.contexts ?? [] }, row.id);
const validArea = (row: unknown): row is Area => record(row) && text(row.id, 500)
    && typeof row.name === 'string' && [row.createdAt, row.updatedAt].every((value) =>
        iso(value) || (typeof value === 'string' && !value.trim()))
    && (row.deletedAt === undefined || iso(row.deletedAt));
// Match the existing Reference raw codec allowance without changing the guarded BEFORE.
const validContextProject = (row: unknown): row is Project => record(row) && text(row.id, 500)
    && (row.deletedAt === undefined || iso(row.deletedAt)) && (row.purgedAt === undefined || iso(row.purgedAt))
    && validProject({ ...row, tagIds: row.tagIds ?? [], deletedAt: undefined, purgedAt: undefined,
        ...(Array.isArray(row.attachments) ? { attachments: row.attachments.map((attachment) => record(attachment)
            && (attachment.updatedAt === undefined || attachment.updatedAt === '')
            ? { ...attachment, updatedAt: attachment.createdAt } : attachment) } : {}) }, row.id);
const hasOnly = (row: Record<string, unknown>, required: string[], optional: string[] = []) =>
    required.every((name) => Object.prototype.hasOwnProperty.call(row, name)) && Object.keys(row).every((name) => required.includes(name) || optional.includes(name));
const finiteDate = (value: unknown) => typeof value === 'string' && value.length <= 100 && Number.isFinite(Date.parse(value));
const frozenInstant = (value: unknown): boolean => record(value) && exact(value, ['epochMs', 'offsetMinutes', 'local'])
    && typeof value.epochMs === 'number' && Number.isFinite(value.epochMs)
    && Number.isInteger(value.offsetMinutes) && Math.abs(value.offsetMinutes as number) <= 840
    && typeof value.local === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/.test(value.local)
    && Date.parse(`${value.local}Z`) + (value.offsetMinutes as number) * 60_000 === value.epochMs;
// This is a frozen native journal witness, as in task-checklist. The shared builder
// validates source anchors, field presence, UNTIL and RRULE; replay never derives
// the next occurrence using a later local clock or timezone. A completely coherently
// rewritten precommit journal is outside this unauthenticated witness boundary.
const validRecurrenceProjection = (value: unknown): boolean => {
    if (value === null) return true;
    if (!record(value) || !hasOnly(value, ['version', 'sourceAnchorDays', 'candidate', 'until'], ['rruleUntilSourceToken', 'rruleText'])
        || value.version !== 1 || !record(value.sourceAnchorDays)
        || !hasOnly(value.sourceAnchorDays, [], ['startTime', 'dueDate', 'reviewAt'])
        || !Object.values(value.sourceAnchorDays).every((day) => Number.isInteger(day) && (day as number) >= 1 && (day as number) <= 31)
        || !record(value.candidate) || !hasOnly(value.candidate, [], ['startTime', 'dueDate', 'reviewAt', 'relativeStartOffset'])
        || ['startTime', 'dueDate', 'reviewAt'].some((name) => Object.prototype.hasOwnProperty.call(value.candidate, name) && !finiteDate((value.candidate as Record<string, unknown>)[name]))
        || (value.candidate.relativeStartOffset !== undefined && (!record(value.candidate.relativeStartOffset)
            || !exact(value.candidate.relativeStartOffset, ['amount', 'unit'])
            || !same(normalizeRelativeStartOffset(value.candidate.relativeStartOffset), value.candidate.relativeStartOffset)))
        || (value.rruleUntilSourceToken !== undefined && !text(value.rruleUntilSourceToken, 100))
        || (value.rruleText !== undefined && !text(value.rruleText, 2000))) return false;
    if (value.until === null) return true;
    if (!record(value.until) || !hasOnly(value.until, ['normalized', 'comparison'], ['rruleUntilToken'])
        || !finiteDate(value.until.normalized) || (value.until.rruleUntilToken !== undefined && !text(value.until.rruleUntilToken, 100))) return false;
    const part = value.until.comparison;
    if (part === null) return true;
    if (!record(part) || !frozenInstant(part.candidate)) return false;
    return part.kind === 'local-day'
        ? exact(part, ['kind', 'candidate', 'candidateDay', 'untilDay'])
            && typeof part.candidateDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(part.candidateDay)
            && typeof part.untilDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(part.untilDay)
        : part.kind === 'epoch' && exact(part, ['kind', 'candidate', 'untilInstant', 'candidateMs', 'untilMs'])
            && frozenInstant(part.untilInstant) && typeof part.candidateMs === 'number' && Number.isFinite(part.candidateMs)
            && typeof part.untilMs === 'number' && Number.isFinite(part.untilMs);
};
const relevantSettings = (settings: AppData['settings']): AppData['settings'] => JSON.parse(JSON.stringify({
    deviceId: settings.deviceId, filters: settings.filters, taskSortBy: settings.taskSortBy,
    features: { timeEstimates: settings.features?.timeEstimates },
    gtd: { autoArchiveDays: settings.gtd?.autoArchiveDays },
})) as AppData['settings'];

const moveSettings = (settings: AppData['settings'], source: MoveSource): AppData['settings'] => {
    if (source === 'reference') return relevantSettings(settings);
    const value = relevantSettings(settings); delete value.filters;
    return JSON.parse(JSON.stringify({ ...value, features: { ...value.features, priorities: settings.features?.priorities } })) as AppData['settings'];
};

/** Bounded container membership, plus every normalized projectless recurrence peer. */
export const referenceTasksMoveScope = (request: MoveRequest,
    data: Pick<AppData, 'tasks' | 'projects' | 'sections' | 'areas' | 'settings'>): NativeReferenceTasksMoveScope => {
    const selected = new Set(request.taskIds);
    const bySection = buildEntityMap(data.sections);
    const normalizedProject = (row: Task) => typeof row.projectId === 'string' && row.projectId.trim() ? row.projectId : undefined;
    // Inbox filter-option visibility and grouping depend on its other rows too.
    const sources = data.tasks.filter((row) => selected.has(row.id) || (sourceOf(request) === 'inbox' && row.status === 'inbox'));
    const parentIds = new Set([...sources.flatMap((row) => {
        const parent = normalizedProject(row);
        const inferred = row.sectionId ? bySection.get(row.sectionId)?.projectId : undefined;
        return [...(parent ? [parent] : []), ...(inferred ? [inferred] : [])];
    }), ...(readFilterState(request.params.filters)?.projects ?? [])]);
    const selectedSections = new Set(sources.flatMap((row) => row.sectionId ? [row.sectionId] : []));
    const projectlessPeers = request.status === 'done' && sources.some((row) => !normalizedProject(row)
        && historyRowLoadProjection(row, row.updatedAt).recurrence);
    const tasks = data.tasks.filter((row) => selected.has(row.id) || (sourceOf(request) === 'inbox' && row.status === 'inbox') || (projectlessPeers && !normalizedProject(row))
        || Boolean(normalizedProject(row) && parentIds.has(normalizedProject(row)!))
        || Boolean(!normalizedProject(row) && row.sectionId && parentIds.has(bySection.get(row.sectionId)?.projectId ?? '')));
    const projects = data.projects.filter((row) => parentIds.has(row.id));
    const filters = sourceOf(request) === 'reference' ? data.settings.filters as unknown : undefined;
    const filterIds = typeof filters === 'string' ? [filters] : record(filters)
        ? [filters.areaId, ...(['areaIds', 'excludedAreaIds', 'included', 'excluded'].flatMap((name) =>
            Array.isArray(filters[name]) ? filters[name] as unknown[] : []))].filter((id): id is string => typeof id === 'string') : [];
    const areaIds = new Set([...sources, ...projects].flatMap((row) => row.areaId ? [row.areaId] : []).concat(filterIds));
    return { tasks, projects, sections: data.sections.filter((row) => parentIds.has(row.projectId) || selectedSections.has(row.id)),
        areas: data.areas.filter((row) => areaIds.has(row.id)), settings: moveSettings(data.settings, sourceOf(request)) };
};
const rawScope = (scope: NativeReferenceTasksMoveScope): NativeReferenceTasksMoveScope | null => {
    const tasks = scope.tasks.map(rawReadTaskSnapshot); const projects = scope.projects.map(rawReadProjectSnapshot);
    return tasks.every((row) => row !== null) && projects.every((row) => row !== null)
        ? { ...scope, tasks: tasks as Task[], projects: projects as Project[], areas: scope.areas.map(rawReadAreaSnapshot) } : null;
};
const loadedProject = (project: Project): Project => {
    const values = projectToSqliteRow(project);
    return normalizeProjectLifecycleFields(projectFromSqliteRow(Object.fromEntries(
        PROJECT_SQLITE_COLUMNS.map((name, index) => [name, values[index]]))));
};
const settingsReadable = (settings: AppData['settings']): boolean => {
    const raw = rawReadSettingsJson(settings, JSON.stringify(settings));
    if (raw == null) return true;
    try { return record(JSON.parse(raw)); } catch { return false; }
};
const requiredDates = (scope: NativeReferenceTasksMoveScope) => [...new Set(scope.tasks.flatMap((row) =>
    [row.startTime, row.dueDate, row.reviewAt].filter((value): value is string => typeof value === 'string')))].sort();
const selectable = (request: MoveRequest, scope: NativeReferenceTasksMoveScope, at: string, temporal?: TaskLoadTemporalContext): Set<string> => {
    const kind = sourceOf(request);
    const t = (name: string) => name;
    const tasks = scope.tasks.map((row) => historyRowLoadProjection(row, at, temporal));
    const allProjects = scope.projects.map(loadedProject);
    const projects = allProjects.filter((row) => !row.deletedAt && !row.purgedAt && row.status !== 'archived');
    const areas = scope.areas.filter((row) => !row.deletedAt);
    const selected = selectStatusListTasks({ kind, tasks, projects, allProjects,
        resolvedAreaFilter: resolveAreaFilterSelection(scope.settings.filters, areas),
        areaById: buildEntityMap(areas), includeArchivedProjects: 'includeArchivedProjects' in request.params ? request.params.includeArchivedProjects : undefined });
    const options = buildStatusListFilterOptions({ kind, tasks: selected, allProjects, settings: scope.settings, t });
    const resolved = resolveListFilterState(readFilterState(request.params.filters)!, {
        visibility: options.visibility, ...(kind === 'reference' ? { retainProjects: options.retainProjects, getProjectLabel: options.getProjectLabel } : {}), t });
    const model = buildStatusListModel({ kind, tasks: selected, projects, areas, settings: scope.settings,
        groupBy: request.params.groupBy ?? (kind === 'reference' ? REFERENCE_LIST_DEFAULT_GROUP_BY : 'none'), criteria: resolved.criteria,
        searchQuery: resolved.searchQuery, collapsedGroupIds: new Set(request.params.collapsedGroupIds ?? []), t, now: new Date(at) });
    return new Set(model.items.flatMap((item) => item.type === 'task'
        && !isStatusListTaskReadOnly(item.task, allProjects) ? [item.task.id] : []));
};
const selectedSourcesMatch = (request: MoveRequest, scope: NativeReferenceTasksMoveScope, at: string, temporal?: TaskLoadTemporalContext): boolean => {
    const eligible = selectable(request, scope, at, temporal); const byId = buildEntityMap(scope.tasks);
    return request.taskIds.every((id) => { const row = byId.get(id); return row && row.status === sourceOf(request)
        && !row.deletedAt && !row.purgedAt && !isProjectedRecurringTaskId(id) && eligible.has(id)
        && taskRevisionOf(historyRowLoadProjection(row, at, temporal)) === request.taskRevisions[id]; });
};

const referenceSourcesMatch = (request: NativeReferenceTasksMoveRequest, scope: NativeReferenceTasksMoveScope, at: string): boolean =>
    sourceOf(request) === 'reference' && selectedSourcesMatch(request, scope, at);

/** Actual RN loaded-before batch planner. UUID allocation never happens during replay. */
export const referenceTasksMoveEffect = (prepared: Pick<MovePrepared,
    'request' | 'scope' | 'deviceIdBefore' | 'deviceIdToInitialize' | 'updateAt' | 'futureBoundary' | 'dates' | 'recurrenceProjections' | 'allocatedIds'>,
    allocate = false): NativeReferenceTasksMovePrepared['effect'] | null => {
    const { request, scope } = prepared;
    const tasks = scope.tasks.map((row) => historyRowLoadProjection(row, prepared.updateAt));
    const projects = scope.projects.map(loadedProject);
    const preflight = prepareTaskBatchUpdatesForStore({ updatesList: request.taskIds.map((id) => ({ id, updates: { status: request.status } })),
        state: { _tasksById: buildEntityMap(tasks), _projectsById: buildEntityMap(projects), _allProjects: projects,
            _allSections: scope.sections, _allAreas: scope.areas, settings: scope.settings, persistenceFailure: null },
        futureBoundary: prepared.futureBoundary, futureDates: new Map(prepared.dates.map((row) => [row.value, row])), nowMs: Date.parse(prepared.updateAt) });
    if (!preflight.ok || preflight.optimisticRetryProjectIds.length) return null;
    let cursor = 0;
    const createId = () => {
        if (allocate) prepared.allocatedIds.push(generateUUID());
        const id = prepared.allocatedIds[cursor++];
        if (!id || !UUID.test(id)) throw new Error('Missing frozen identity');
        return id;
    };
    const planned = planTaskBatchUpdateEffects({ preparedUpdatesById: preflight.preparedUpdatesById, allTasks: tasks,
        allProjects: projects, allSections: scope.sections, now: prepared.updateAt,
        deviceId: prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, createId,
        recurrenceProjections: new Map(prepared.recurrenceProjections.map((row) => [row.id, row.projection])) });
    if (cursor !== prepared.allocatedIds.length || new Set(prepared.allocatedIds).size !== prepared.allocatedIds.length
        || planned.tasks.length !== tasks.length + planned.createdTasks.length) return null;
    const pairs = <T extends { id: string }>(raw: T[], loaded: T[], after: T[]): { before: T; after: T }[] => {
        const loadedById = buildEntityMap(loaded); const afterById = buildEntityMap(after);
        return raw.flatMap((before) => { const result = afterById.get(before.id);
            return !result ? [] : same(loadedById.get(before.id), result) ? [] : [{ before, after: result }]; });
    };
    return { tasks: pairs(scope.tasks, tasks, planned.tasks), createdTasks: planned.createdTasks,
        projects: pairs(scope.projects, projects, planned.projects), sections: pairs(scope.sections, scope.sections, planned.sections) };
};
export const readTasksMoveEnvelope = (input: unknown, source: MoveSource): MoveEnvelope | null => {
    const envelope = detach<Record<string, unknown>>(input);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readMoveRequest(envelope.request, source); const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'scope', 'effect', 'deviceIdBefore', 'deviceIdToInitialize', 'updateAt',
        'preparedLocalDay', 'preparedOffsetMinutes', 'boundaryOffsetMinutes', 'futureBoundary', 'dates', 'recurrenceProjections', 'allocatedIds', 'result'])
        || raw.version !== 1 || !same(raw.request, request) || !record(raw.scope)
        || !exact(raw.scope, ['tasks', 'projects', 'sections', 'areas', 'settings'])
        || !Array.isArray(raw.scope.tasks) || !raw.scope.tasks.every(validTask) || !unique(raw.scope.tasks)
        || !Array.isArray(raw.scope.projects) || !raw.scope.projects.every(validContextProject) || !unique(raw.scope.projects)
        || !Array.isArray(raw.scope.sections) || !raw.scope.sections.every((row) => record(row) && text(row.id, 500)
            && text(row.projectId, 500) && validSection(row, row.id, row.projectId)) || !unique(raw.scope.sections)
        || !Array.isArray(raw.scope.areas) || !raw.scope.areas.every(validArea) || !unique(raw.scope.areas)
        || !record(raw.scope.settings) || !same(moveSettings(raw.scope.settings, source), raw.scope.settings)
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
            && validRecurrenceProjection(row.projection) && (request.status === 'done' || row.projection === null))
        || !Array.isArray(raw.allocatedIds) || !raw.allocatedIds.every((id) => typeof id === 'string' && UUID.test(id))
        || new Set(raw.allocatedIds).size !== raw.allocatedIds.length
        || !record(raw.result) || !exact(raw.result, ['count', 'status']) || raw.result.count !== request.taskIds.length || raw.result.status !== request.status) return null;
    try {
        const prepared = raw as unknown as MovePrepared;
        const expected = referenceTasksMoveEffect(prepared);
        return selectedSourcesMatch(request, prepared.scope, prepared.updateAt)
            && (prepared.scope.settings.deviceId ?? null) === prepared.deviceIdBefore
            && same(referenceTasksMoveScope(request, prepared.scope), prepared.scope)
            && new Date(Date.parse(prepared.updateAt) - prepared.preparedOffsetMinutes * 60_000).toISOString().slice(0, 10) === prepared.preparedLocalDay
            && new Date(Date.parse(`${prepared.preparedLocalDay}T23:59:59.999Z`) + prepared.boundaryOffsetMinutes * 60_000).toISOString() === prepared.futureBoundary
            && same(requiredDates(prepared.scope), prepared.dates.map((row) => row.value))
            && expected && same(expected, prepared.effect)
            && request.taskIds.every((id) => expected.tasks.some((pair) => pair.before.id === id))
            && [...prepared.effect.tasks, ...prepared.effect.projects, ...prepared.effect.sections].every((pair) => record(pair) && exact(pair, ['before', 'after']))
            ? envelope as MoveEnvelope : null;
    } catch { return null; }
};

export const readReferenceTasksMoveEnvelope = (input: unknown): NativeReferenceTasksMoveEnvelope | null =>
    readTasksMoveEnvelope(input, 'reference') as NativeReferenceTasksMoveEnvelope | null;

/** Exact raw scope plus a frozen replan; the adapter epoch fence proves it again inside BEGIN. */
export const referenceTasksMoveAuthorityMatches = (prepared: MovePrepared, data: AppData): boolean => {
    const current = rawScope(referenceTasksMoveScope(prepared.request, data));
    return Boolean(current && same(current, prepared.scope) && selectedSourcesMatch(prepared.request, current, prepared.updateAt)
        && !data.tasks.some((row) => prepared.allocatedIds.includes(row.id))
        && same(referenceTasksMoveEffect({ ...prepared, scope: current }), prepared.effect));
};

export function createTasksMoveMethods(deps: {
    readiness: () => NativeHostResult<null>; save: () => Promise<NativeHostResult<null>>;
}, source: MoveSource) {
    const label = source === 'inbox' ? 'Inbox' : 'Reference';
    const guardedAdapter = (): NativeHostResult<null> => {
        const adapter = getStorageAdapter();
        return adapter instanceof NativeReceiptSqliteAdapter && adapter.concurrentWritesGuarded
            ? { ok: true, value: null } : fail('SAVE_FAILED', `${label} Move requires guarded canonical SQLite storage`);
    };
    const checkForeignKeyAuthority = async (adapter: ReturnType<typeof getStorageAdapter>): Promise<NativeHostResult<null>> => {
        if (getStorageAdapter() !== adapter) return fail('STALE_REVISION', `${label} Move storage changed while reading`);
        if (!(adapter instanceof NativeReceiptSqliteAdapter) || !adapter.concurrentWritesGuarded)
            return fail('SAVE_FAILED', `${label} Move requires guarded canonical SQLite storage`);
        try {
            const invalid = await adapter.hasForeignKeyViolations();
            if (getStorageAdapter() !== adapter) return fail('STALE_REVISION', `${label} Move storage changed while reading`);
            return invalid ? fail('SAVE_FAILED', `Saved ${label} data has invalid container references`) : { ok: true, value: null };
        } catch { return fail('SAVE_FAILED', `Saved ${label} container references could not be checked`); }
    };
    const saves = createAreaSaveGuard(deps.save);
    let pending: { envelope: MoveEnvelope; adapter: ReturnType<typeof getStorageAdapter>;
        boundary: PreparedNativeSaveBoundary | undefined } | null = null;
    const payload = (envelope: MoveEnvelope) => canonicalPayload([source === 'inbox' ? 'inboxTasksMove' : 'referenceTasksMove', envelope]);
    const checkAuthority = (envelope: MoveEnvelope, authority: PreparedAreaAuthority): NativeHostResult<null> => {
        const guarded = guardedAdapter(); if (!guarded.ok) return guarded;
        if (!settingsReadable(authority.snapshot.settings)) return fail('SAVE_FAILED', `Saved ${label} settings JSON is unreadable`);
        const prepared = envelope.prepared; const current = rawScope(referenceTasksMoveScope(envelope.request, authority.snapshot));
        if (!current) return fail('SAVE_FAILED', `Saved ${label} raw JSON could not be bound safely`);
        if (!same(current, prepared.scope) || !selectedSourcesMatch(envelope.request, current, prepared.updateAt)
            || authority.snapshot.tasks.some((row) => prepared.allocatedIds.includes(row.id)))
            return fail('STALE_REVISION', `${label} selection or its saved dependency context changed`);
        try { return same(referenceTasksMoveEffect({ ...prepared, scope: current }), prepared.effect)
            ? { ok: true, value: null } : fail('STALE_REVISION', `${label} Move rules changed since preparation`); }
        catch { return fail('STALE_REVISION', `${label} Move destination changed since preparation`); }
    };
    const apply = (envelope: MoveEnvelope, authority: PreparedAreaAuthority) =>
        source === 'inbox'
            ? useTaskStore.getState().commitPreparedInboxTasksMove(envelope.prepared as NativeInboxTasksMovePrepared, authority)
            : useTaskStore.getState().commitPreparedReferenceTasksMove(envelope.prepared as NativeReferenceTasksMovePrepared, authority);
    const receipts = createNativeRequestReceipts({ save: async (requestId) => {
        const owned = pending;
        if (!owned || owned.envelope.request.requestId !== requestId) return fail('SAVE_FAILED', `${label} Move has no owned raw save`);
        if (useTaskStore.getState().persistenceFailure) {
            if (!saves.mayApply(owned.envelope, owned.adapter)) return fail('SAVE_FAILED', `${label} Move has an unrelated persistence failure`);
            const read = await readAreaDurableData(true, true); if (!read.ok) return read;
            if (read.value.adapter !== owned.adapter) return fail('STALE_REVISION', `${label} Move storage changed before retry`);
            const foreignKeys = await checkForeignKeyAuthority(read.value.adapter); if (!foreignKeys.ok) return foreignKeys;
            const checked = checkAuthority(owned.envelope, read.value.authority); if (!checked.ok) return checked;
            const applied = await apply(owned.envelope, read.value.authority);
            if (!applied.success || applied.outcome !== 'applied') return fail('STALE_REVISION', applied.error ?? `${label} Move retry was superseded`);
            owned.boundary = read.value.authority.saveBoundary;
        }
        const saved = await saves.finish(owned.envelope, owned.adapter, false, owned.boundary);
        if (saved.ok) pending = null;
        return saved;
    } });
    return {
        async prepareTasksMove(input: MoveRequest): Promise<NativeHostResult<{ kind: 'prepared'; prepared: MovePrepared }>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const guarded = guardedAdapter(); if (!guarded.ok) return guarded;
            const request = readMoveRequest(input, source);
            if (!request) return fail('INVALID_INPUT', `Select saved ${label} tasks with their exact revisions and list scope; select fewer tasks if the request is too large`);
            const memory = useTaskStore.getState(); const now = new Date();
            if (!selectedSourcesMatch(request, { tasks: memory._allTasks, projects: memory._allProjects, sections: memory._allSections,
                areas: memory._allAreas, settings: memory.settings }, now.toISOString())) return fail('STALE_REVISION', `${label} selection changed since it was shown`);
            const read = await readAreaDurableData(false, true); if (!read.ok) return read;
            const foreignKeys = await checkForeignKeyAuthority(read.value.adapter); if (!foreignKeys.ok) return foreignKeys;
            const data = read.value.authority.snapshot;
            if (!settingsReadable(data.settings)) return fail('SAVE_FAILED', `Saved ${label} settings JSON is unreadable`);
            const scope = rawScope(referenceTasksMoveScope(request, data));
            if (!scope) return fail('SAVE_FAILED', `Saved ${label} raw JSON could not be bound safely`);
            if (!selectedSourcesMatch(request, scope, now.toISOString())) return fail('STALE_REVISION', `Saved ${label} selection changed`);
            const end = new Date(now); end.setHours(23, 59, 59, 999); const device = ensureDeviceId(scope.settings);
            const loaded = buildEntityMap(scope.tasks.map((row) => historyRowLoadProjection(row, now.toISOString())));
            const base = { version: 1 as const, request, scope, deviceIdBefore: scope.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null, updateAt: now.toISOString(),
                preparedLocalDay: new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10),
                preparedOffsetMinutes: now.getTimezoneOffset(), boundaryOffsetMinutes: end.getTimezoneOffset(), futureBoundary: end.toISOString(),
                dates: projectFocusDateValues(requiredDates(scope)), recurrenceProjections: request.taskIds.map((id) => ({ id,
                    projection: request.status === 'done' ? projectNextRecurringTask(loaded.get(id)!, now.toISOString()) : null })),
                allocatedIds: [] as string[], result: { count: request.taskIds.length, status: request.status } };
            let effect;
            try {
                const fullScope = rawScope({ tasks: data.tasks, projects: data.projects, sections: data.sections, areas: data.areas,
                    settings: moveSettings(data.settings, source) });
                if (!fullScope) return fail('SAVE_FAILED', `Saved ${label} raw JSON could not be bound safely`);
                const first = referenceTasksMoveEffect({ ...base, scope: fullScope, dates: projectFocusDateValues(requiredDates(fullScope)) }, true);
                effect = referenceTasksMoveEffect(base);
                if (!same(first, effect) || data.tasks.some((row) => base.allocatedIds.includes(row.id))) effect = null;
            } catch { effect = null; }
            const prepared = effect && jsonSafe<MovePrepared>({ ...base, effect });
            return prepared && readTasksMoveEnvelope({ request, prepared }, source) ? { ok: true, value: { kind: 'prepared', prepared } }
                : fail('INVALID_INPUT', `${label} Move cannot prepare these rows or its journal is too large; select fewer tasks`);
        },
        validatePreparedTasksMove(input: MoveEnvelope): NativeHostResult<MovePrepared['result']> {
            const envelope = readTasksMoveEnvelope(input, source); return envelope ? { ok: true, value: envelope.prepared.result }
                : fail('INVALID_INPUT', `Prepared ${label} Move is malformed`);
        },
        tasksMoveOutcome(input: MoveEnvelope): NativeHostResult<MovePrepared['result'] | null> {
            const envelope = readTasksMoveEnvelope(input, source); return envelope
                ? receipts.saved<MovePrepared['result']>(envelope.request.requestId, payload(envelope)) ?? { ok: true, value: null }
                : fail('INVALID_INPUT', `Prepared ${label} Move is malformed`);
        },
        async commitPreparedTasksMove(input: MoveEnvelope): Promise<NativeHostResult<MovePrepared['result']>> {
            const envelope = readTasksMoveEnvelope(input, source); if (!envelope) return fail('INVALID_INPUT', `Prepared ${label} Move is malformed`);
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const guarded = guardedAdapter(); if (!guarded.ok) return guarded;
            const boundPayload = payload(envelope); const saved = receipts.saved<MovePrepared['result']>(envelope.request.requestId, boundPayload);
            if (saved) return saved.ok && !same(saved.value, envelope.prepared.result)
                ? fail('INVALID_INPUT', `Saved ${label} Move result does not match its journal`) : saved;
            let prewriteFailure: NativeHostResult<never> | null = null;
            const notLanded = (message: string): NativeHostResult<never> => { prewriteFailure = fail('SAVE_FAILED', message);
                return { ok: false, error: { code: 'ACTION_FAILED', message } }; };
            const confirmed = await receipts.run(envelope.request.requestId, boundPayload, async () => {
                if (useTaskStore.getState().persistenceFailure) return notLanded(`${label} Move has an unresolved persistence failure`);
                const read = await readAreaDurableData(false, true);
                if (!read.ok) return read.error.code === 'SAVE_FAILED' ? notLanded(read.error.message) : read;
                const foreignKeys = await checkForeignKeyAuthority(read.value.adapter);
                if (!foreignKeys.ok) return foreignKeys.error.code === 'SAVE_FAILED' ? notLanded(foreignKeys.error.message) : foreignKeys;
                const checked = checkAuthority(envelope, read.value.authority); if (!checked.ok) return checked;
                const applied = await apply(envelope, read.value.authority);
                if (!applied.success || applied.outcome !== 'applied') return fail('STALE_REVISION', applied.error ?? `${label} Move conflicts with saved data`);
                pending = { envelope, adapter: read.value.adapter, boundary: read.value.authority.saveBoundary };
                return { ok: true, value: envelope.prepared.result };
            });
            if (prewriteFailure) return prewriteFailure;
            if (confirmed.ok && !same(confirmed.value, envelope.prepared.result)) return fail('INVALID_INPUT', `Saved ${label} Move result does not match its journal`);
            if (confirmed.ok) {
                try { logInfo(`Native ${label} bulk status confirmed`, { scope: 'native-host', category: 'storage',
                    context: { releaseCheck: source === 'inbox' ? 'v1.3.5/ios-inbox-bulk-status' : 'v1.3.4/ios-reference-bulk-status', count: confirmed.value.count,
                        status: confirmed.value.status, outcome: 'moved' } }); }
                catch { /* Diagnostics cannot invalidate a durable acknowledgment. */ }
            }
            return confirmed;
        },
    };
}

export function createReferenceTasksMoveMethods(deps: Parameters<typeof createTasksMoveMethods>[0]) {
    const methods = createTasksMoveMethods(deps, 'reference');
    return {
        prepareReferenceTasksMove: (input: NativeReferenceTasksMoveRequest) => methods.prepareTasksMove(input) as Promise<NativeHostResult<NativeReferenceTasksMovePreparation>>,
        validatePreparedReferenceTasksMove: (input: NativeReferenceTasksMoveEnvelope) => methods.validatePreparedTasksMove(input) as NativeHostResult<NativeReferenceTasksMoveResult>,
        referenceTasksMoveOutcome: (input: NativeReferenceTasksMoveEnvelope) => methods.tasksMoveOutcome(input) as NativeHostResult<NativeReferenceTasksMoveResult | null>,
        commitPreparedReferenceTasksMove: (input: NativeReferenceTasksMoveEnvelope) => methods.commitPreparedTasksMove(input) as Promise<NativeHostResult<NativeReferenceTasksMoveResult>>,
    };
}

/** Additive reuse for Reference batch families; Move V1 bodies/bytes stay unchanged. */
export { detach as detachReferenceBatchJson, jsonSafe as detachReferenceBatchValue,
    validRecurrenceProjection as validReferenceBatchRecurrenceProjection,
    readRequest as readReferenceBatchSelectionRequest, readMoveRequest as readStatusBatchSelectionRequest,
    selectedSourcesMatch as statusBatchSourcesMatch, moveSettings as statusBatchSettings, rawScope as rawReferenceBatchScope,
    loadedProject as loadedReferenceBatchProject, settingsReadable as referenceBatchSettingsReadable,
    requiredDates as requiredReferenceBatchDates, referenceSourcesMatch as referenceBatchSourcesMatch,
    validTask as validReferenceBatchTask, validContextProject as validReferenceBatchProject,
    validArea as validReferenceBatchArea, relevantSettings as relevantReferenceBatchSettings };

// The store's Reference move action reads these here: it cannot import this module (store-reference-batch-modules.ts).
referenceBatchModules.shared = { historyRowLoadProjection, NativeReceiptSqliteAdapter };
referenceBatchModules.move = (input) => {
    const prepared = input as NativeReferenceTasksMovePrepared;
    return {
        validateEnvelope: () => Boolean(readReferenceTasksMoveEnvelope({ request: prepared.request, prepared })),
        authorityMatches: (data) => referenceTasksMoveAuthorityMatches(prepared, data),
    };
};
