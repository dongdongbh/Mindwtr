import { sha256 } from '@noble/hashes/sha2.js';
import { buildBoardColumns, EMPTY_BOARD_FILTER_STATE, isBoardStatus, planBoardDrop, resolveBoardFilterState, type BoardFilterState, type BoardStatus } from './board-view-model';
import { isTaskVisibleInArea, resolveAreaFilterSelection } from './area-filter';
import { detach, exact, iso, record, validProject } from './native-host-contract-project-shared';
import { validSection } from './native-host-contract-project-section-rename';
import { validRawTask } from './native-host-contract-task-save';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { AREA_SYNC_FIELD_SCHEMA } from './area-sync-schema';
import { TASK_SYNC_FIELD_SCHEMA } from './task-sync-schema';
import { boardTaskOrderUpdates } from './store-projects/ordering-actions';
import { boardReactivationContainerAllowed, planTaskMutations, samePreparedBoardOrderTask, samePreparedBoardOrderBefore } from './store-tasks';
import { selectVisibleTasks } from './store-helpers';
import { sameSectionDeleteJson as same } from './store-projects/section-actions';
import { isProjectedRecurringTaskId } from './recurrence';
import { createAreaSaveGuard, readAreaDurableData } from './native-host-contract-area-durable';
import { createNativeRequestReceipts, isNativeRequestReceiptDurable, NativeReceiptSqliteAdapter, taskRevisionOf } from './native-request-receipts';
import { getPersistenceStatus, getStorageAdapter, useTaskStore } from './store';
import type { NativeHostResult } from './native-host-contract';
import type { AppData, Area, Project, Section, Task } from './types';
import type { PreparedAreaAuthority, PreparedNativeSaveBoundary, TaskStore } from './store-types';

export type NativeBoardOrderRequest = { requestId: string; action: { type: 'orderCard'; taskId: string; taskRevision: string;
    status: BoardStatus; afterId: string | null; filters: BoardFilterState; expectedOrder: string } };
export type NativeBoardOrderScope = { columnTasks: Task[]; shownIds: string[]; areaFilter: { included: string[]; excluded: string[] };
    projects: Project[]; sections: Section[]; areas: Area[] };
export type NativePreparedBoardOrder = { version: 1; request: NativeBoardOrderRequest; scope: NativeBoardOrderScope;
    effect: { tasks: Array<{ before: Task; after: Task }> }; deviceIdBefore: string; preparedAt: string;
    result: { changed: true; open: null } };
export type NativeBoardOrderEnvelope = { request: NativeBoardOrderRequest; prepared: NativePreparedBoardOrder };
export type NativeBoardOrderActions = { up: { afterId: string | null } | null; down: { afterId: string | null } | null };
export type NativeBoardColumnOrder = { available: boolean; expectedOrder: string | null; moveUpLabel: string; moveDownLabel: string };
type State = Pick<TaskStore, '_allTasks' | '_allProjects' | '_allSections' | '_allAreas' | 'settings'>;
type Snapshot = { scope: NativeBoardOrderScope; filters: BoardFilterState; token: string };
const canonical = (value: unknown) => JSON.stringify(value, (_name, part) => record(part)
    ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : part);
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED' | 'ACTION_FAILED', message: string): NativeHostResult<never> => ({ ok: false, error: { code, message } });
const text = (value: unknown, max = 500): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const unique = (rows: readonly { id: string }[]) => new Set(rows.map(row => row.id)).size === rows.length;
const sorted = <T extends { id: string }>(rows: T[]): T[] => rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const TOKEN = /^boardOrder:[0-9a-f]{64}$/;
const validFilters = (value: unknown): value is BoardFilterState => record(value) && exact(value, Object.keys(EMPTY_BOARD_FILTER_STATE))
    && ['tokens', 'excludedTokens', 'projects'].every(name => Array.isArray(value[name])
        && value[name].length <= 1000 && value[name].every((v: unknown) => typeof v === 'string' && v.length <= 500)
        && new Set(value[name]).size === value[name].length)
    && typeof value.searchQuery === 'string' && value.searchQuery.length <= 2000
    && ['any', 'all'].includes(String(value.contextMatchMode)) && ['any', 'all'].includes(String(value.tagMatchMode))
    && (value.duePreset === null || ['today', 'this_week', 'this_month', 'overdue', 'no_date'].includes(String(value.duePreset)));
const validTask = (value: unknown): value is Task => {
    if (!record(value) || !text(value.id) || !validRawTask(value, value.id)) return false;
    const numbers = new Set(['pushCount', 'timeSpentMinutes', 'repeatReminderMinutes', 'rev', 'order', 'orderNum', 'boardOrder', 'focusOrder']);
    const booleans = new Set(['showFutureRecurrence', 'isFocusedToday', 'suppressMindwtrReminders', 'isFocusedTodayBeforeProjectArchive']);
    for (const [name, part] of Object.entries(value)) {
        if (part === null) continue;
        if (numbers.has(name)) { if (typeof part !== 'number' || !Number.isFinite(part)) return false; continue; }
        if (booleans.has(name)) { if (typeof part !== 'boolean') return false; continue; }
        if (['tags', 'contexts'].includes(name)) continue;
        if (name === 'checklist') {
            if (!Array.isArray(part) || !part.every(row => record(row) && exact(row, ['id', 'title', 'isCompleted'])
                && text(row.id) && typeof row.title === 'string' && typeof row.isCompleted === 'boolean')) return false;
        } else if (name === 'attachments') {
            if (!Array.isArray(part) || !part.every(row => record(row) && text(row.id) && ['file', 'link'].includes(String(row.kind))
                && typeof row.title === 'string' && typeof row.uri === 'string' && iso(row.createdAt)
                && Object.keys(row).every(field => ['id', 'kind', 'title', 'uri', 'mimeType', 'size', 'createdAt', 'updatedAt', 'deletedAt', 'cloudKey', 'fileHash', 'contentRev', 'contentMtimeMs', 'contentSize', 'pendingContentUpload', 'localStatus'].includes(field))
                && Object.entries(row).every(([field, entry]) => entry === null || (['size', 'contentRev', 'contentMtimeMs', 'contentSize'].includes(field)
                    ? typeof entry === 'number' && Number.isFinite(entry) : field === 'pendingContentUpload' ? typeof entry === 'boolean' : typeof entry === 'string')))) return false;
        } else if (name === 'viewSectionIds') {
            if (!record(part) || !Object.entries(part).every(([field, entry]) => ['someday', 'waiting', 'focus'].includes(field) && typeof entry === 'string')) return false;
        } else if (name === 'relativeStartOffset') {
            if (!record(part) || !exact(part, ['amount', 'unit']) || typeof part.amount !== 'number' || !Number.isFinite(part.amount)
                || !['minute', 'hour', 'day', 'week'].includes(String(part.unit))) return false;
        } else if (name === 'recurrence') {
            if (typeof part === 'string') { if (!['daily', 'weekly', 'monthly', 'yearly'].includes(part)) return false; }
            else if (!record(part) || !['daily', 'weekly', 'monthly', 'yearly'].includes(String(part.rule))
                || !Object.entries(part).every(([field, entry]) => entry === null || (['count', 'completedOccurrences', 'anchorDay', 'startAnchorDay', 'dueAnchorDay', 'reviewAnchorDay'].includes(field)
                    ? typeof entry === 'number' && Number.isFinite(entry) : ['byDay', 'byMonthDay'].includes(field)
                        ? Array.isArray(entry) && entry.every(item => typeof item === (field === 'byDay' ? 'string' : 'number'))
                        : ['rule', 'seriesId', 'strategy', 'weekStart', 'until', 'rrule'].includes(field) && typeof entry === 'string'))) return false;
        } else if (!TASK_SYNC_FIELD_SCHEMA.some(field => field.name === name) || typeof part !== 'string') return false;
    }
    return true;
};
const validAuthorityProject = (value: unknown): value is Project => record(value) && text(value.id)
    && validProject({ ...value, deletedAt: undefined, purgedAt: undefined }, value.id)
    && (value.deletedAt == null || iso(value.deletedAt)) && (value.purgedAt == null || iso(value.purgedAt));
const validArea = (value: unknown): value is Area => record(value) && text(value.id) && typeof value.name === 'string'
    && Object.keys(value).every(name => AREA_SYNC_FIELD_SCHEMA.some(field => field.name === name))
    && ['color', 'icon', 'revBy'].every(name => value[name] == null || typeof value[name] === 'string')
    && ['createdAt', 'updatedAt', 'deletedAt'].every(name => value[name] == null || iso(value[name]))
    && (value.order == null || typeof value.order === 'number' && Number.isFinite(value.order))
    && (value.rev == null || Number.isSafeInteger(value.rev) && Number(value.rev) >= 0);
const validScope = (value: unknown): value is NativeBoardOrderScope => record(value)
    && exact(value, ['columnTasks', 'shownIds', 'areaFilter', 'projects', 'sections', 'areas'])
    && Array.isArray(value.columnTasks) && value.columnTasks.every(validTask) && unique(value.columnTasks)
    && Array.isArray(value.shownIds) && value.shownIds.every(id => text(id)) && new Set(value.shownIds).size === value.shownIds.length
    && record(value.areaFilter) && exact(value.areaFilter, ['included', 'excluded'])
    && [value.areaFilter.included, value.areaFilter.excluded].every(rows => Array.isArray(rows)
        && rows.every(id => text(id)) && new Set(rows).size === rows.length)
    && [[value.projects, validAuthorityProject], [value.sections, (row: unknown) => record(row) && text(row.id) && text(row.projectId)
        && validSection(row, row.id, row.projectId)], [value.areas, validArea]].every(([rows, valid]) => Array.isArray(rows)
        && rows.every(row => (valid as (value: unknown) => boolean)(row)) && rows.every((row, index) => index === 0 || rows[index - 1].id < row.id));

export const boardOrderWritable = (task: Task, scope: Pick<NativeBoardOrderScope, 'projects' | 'sections' | 'areas'>): boolean =>
    isBoardStatus(task.status) && !task.deletedAt && !task.purgedAt && !isProjectedRecurringTaskId(task.id)
    && boardReactivationContainerAllowed(task, scope.projects, scope.sections)
    && (!task.areaId || scope.areas.filter(row => row.id === task.areaId && !row.deletedAt).length === 1);

/** Preindex relational admission so deriving all read intents stays linear. */
export const boardOrderWritability = (scope: Pick<NativeBoardOrderScope, 'projects' | 'sections' | 'areas'>) => {
    const projects = new Map(scope.projects.map(row => [row.id, row]));
    const sections = new Map(scope.sections.map(row => [row.id, row]));
    const areas = new Map(scope.areas.map(row => [row.id, row]));
    return (task: Task): boolean => {
        const section = sections.get(task.sectionId ?? '');
        const ids = new Set([task.projectId, section?.projectId]);
        return boardOrderWritable(task, { projects: [...ids].flatMap(id => projects.has(id ?? '') ? [projects.get(id!)!] : []),
            sections: section ? [section] : [], areas: areas.has(task.areaId ?? '') ? [areas.get(task.areaId!)!] : [] });
    };
};

export const boardOrderScope = (state: State, status: BoardStatus, shownIds: string[]): NativeBoardOrderScope => {
    const columnTasks = state._allTasks.filter(row => row.status === status && !row.deletedAt);
    const sectionIds = new Set(columnTasks.map(row => row.sectionId));
    const sections = sorted(state._allSections.filter(row => sectionIds.has(row.id)));
    const projectIds = new Set([...columnTasks.map(row => row.projectId), ...sections.map(row => row.projectId)]);
    const projects = sorted(state._allProjects.filter(row => projectIds.has(row.id)));
    const areaFilter = resolveAreaFilterSelection(state.settings.filters, state._allAreas.filter(row => !row.deletedAt));
    const areaIds = new Set([...columnTasks.map(row => row.areaId), ...projects.map(row => row.areaId), ...areaFilter.included, ...areaFilter.excluded]);
    return { columnTasks, shownIds, areaFilter, projects, sections, areas: sorted(state._allAreas.filter(row => areaIds.has(row.id))) };
};
export const boardOrderToken = (status: BoardStatus, filters: BoardFilterState, scope: NativeBoardOrderScope): string | null => {
    const content = ['boardOrder', { status, filters, ...scope }];
    if (!isNativeJsonWithinBytes(content)) return null;
    const value = canonical(content); const bytes = new Uint8Array(value.length * 2);
    for (let i = 0; i < value.length; i++) { const unit = value.charCodeAt(i); bytes[i * 2] = unit >>> 8; bytes[i * 2 + 1] = unit & 255; }
    return `boardOrder:${Array.from(sha256(bytes), byte => byte.toString(16).padStart(2, '0')).join('')}`;
};
const shownFromScope = (status: BoardStatus, filters: BoardFilterState, scope: NativeBoardOrderScope, now: Date): string[] => {
    const areaById = new Map(scope.areas.filter(row => !row.deletedAt).map(row => [row.id, row]));
    const projects = scope.projects.filter(row => !row.deletedAt && !row.purgedAt);
    const projectById = new Map(projects.map(row => [row.id, row]));
    const tasks = selectVisibleTasks(scope.columnTasks).filter(task => isTaskVisibleInArea(task,
        { areaById, projectById, resolvedAreaFilter: scope.areaFilter }));
    const resolved = resolveBoardFilterState(filters, { tokens: [...filters.tokens, ...filters.excludedTokens],
        projectIds: filters.projects, getProjectLabel: id => projectById.get(id)?.title, t: key => key });
    return buildBoardColumns({ tasks, projects, criteria: resolved.criteria, searchQuery: filters.searchQuery, now, t: key => key })
        .find(column => column.status === status)!.tasks.map(row => row.id);
};
export const boardOrderEffect = (request: NativeBoardOrderRequest, scope: NativeBoardOrderScope, at: string, deviceId: string): NativePreparedBoardOrder['effect'] => {
    const source = scope.columnTasks.find(row => row.id === request.action.taskId)!;
    const plan = planBoardDrop({ task: source, status: request.action.status, columnIds: scope.shownIds, afterId: request.action.afterId });
    const updates = plan?.kind === 'reorder' ? boardTaskOrderUpdates(scope.columnTasks, plan.orderedIds, source.id) : new Map<string, number>();
    if ([...updates.values()].some(order => !Number.isSafeInteger(order))) throw new Error('Board order is not storage representable');
    const before = scope.columnTasks.filter(row => updates.has(row.id));
    const after = planTaskMutations({ tasks: before, state: null, buildUpdates: row => ({ boardOrder: updates.get(row.id)! }), now: at, deviceId });
    return { tasks: before.map((row, index) => ({ before: row, after: after[index] })) };
};

export function createBoardOrderMethods(deps: { readiness: () => NativeHostResult<null>; save: () => Promise<NativeHostResult<null>>;
    requestIdPattern: RegExp; readFilters: (value: unknown) => BoardFilterState | null;
    snapshot: (filters: BoardFilterState, now: Date, state: TaskStore) => { filters: BoardFilterState; columns: { status: BoardStatus; tasks: Task[] }[] } }) {
    const request = (value: unknown): NativeBoardOrderRequest | null => {
        const input = detach<Record<string, unknown>>(value);
        if (!input || !isNativeJsonWithinBytes(input, 1_048_576) || !exact(input, ['requestId', 'action'])
            || typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId) || !record(input.action)) return null;
        const a = input.action;
        return exact(a, ['type', 'taskId', 'taskRevision', 'status', 'afterId', 'filters', 'expectedOrder']) && a.type === 'orderCard'
            && text(a.taskId) && text(a.taskRevision, 4096) && isBoardStatus(a.status)
            && (a.afterId === null || text(a.afterId)) && validFilters(a.filters) && deps.readFilters(a.filters) !== null
            && typeof a.expectedOrder === 'string' && TOKEN.test(a.expectedOrder) ? input as unknown as NativeBoardOrderRequest : null;
    };
    const snapshot = (filters: BoardFilterState, status: BoardStatus, now: Date, state = useTaskStore.getState(),
        built?: { filters: BoardFilterState; columns: { status: BoardStatus; tasks: Task[] }[] }): Snapshot | null => {
        const shown = built ?? deps.snapshot(filters, now, state); const effective = shown.filters;
        const scope = detach<NativeBoardOrderScope>(plain(boardOrderScope(state, status, shown.columns.find(column => column.status === status)!.tasks.map(row => row.id))));
        if (!scope || !validScope(scope)) return null;
        const token = boardOrderToken(status, effective, scope);
        return token ? { scope, filters: effective, token } : null;
    };
    const readEnvelope = (value: unknown): NativeBoardOrderEnvelope | null => {
        const input = detach<Record<string, unknown>>(value);
        if (!input || !exact(input, ['request', 'prepared']) || !record(input.prepared)) return null;
        const r = request(input.request); const p = input.prepared;
        if (!r || !exact(p, ['version', 'request', 'scope', 'effect', 'deviceIdBefore', 'preparedAt', 'result']) || p.version !== 1
            || !same(r, p.request) || !validScope(p.scope) || !text(p.deviceIdBefore) || !p.deviceIdBefore.trim() || !iso(p.preparedAt)
            || !same(p.result, { changed: true, open: null }) || !record(p.effect) || !exact(p.effect, ['tasks']) || !Array.isArray(p.effect.tasks)
            || !p.effect.tasks.length || !p.effect.tasks.every(pair => record(pair) && exact(pair, ['before', 'after']) && validTask(pair.before) && validTask(pair.after))) return null;
        const scope = p.scope; const source = scope.columnTasks.find(row => row.id === r.action.taskId);
        const minimalScope = boardOrderScope({ _allTasks: scope.columnTasks, _allProjects: scope.projects,
            _allSections: scope.sections, _allAreas: scope.areas, settings: { filters: { areaIds: scope.areaFilter.included, excludedAreaIds: scope.areaFilter.excluded } } }, r.action.status, scope.shownIds);
        if (!same(minimalScope, scope)) return null;
        if (!source || scope.columnTasks.some(row => row.status !== r.action.status || row.deletedAt) || taskRevisionOf(source) !== r.action.taskRevision
            || !scope.shownIds.includes(source.id) || r.action.afterId !== null && (r.action.afterId === source.id || !scope.shownIds.includes(r.action.afterId))
            || !boardOrderWritable(source, scope) || boardOrderToken(r.action.status, r.action.filters, scope) !== r.action.expectedOrder
            || !same(shownFromScope(r.action.status, r.action.filters, scope, new Date(p.preparedAt)), scope.shownIds)) return null;
        try {
            const effect = boardOrderEffect(r, scope, p.preparedAt, p.deviceIdBefore);
            return effect.tasks.length && effect.tasks.every(pair => boardOrderWritable(pair.before, scope)) && same(effect, p.effect)
                ? input as unknown as NativeBoardOrderEnvelope : null;
        } catch { return null; }
    };
    const fromData = (data: AppData): TaskStore => ({ ...useTaskStore.getState(), _allTasks: data.tasks, _allProjects: data.projects,
        _allSections: data.sections ?? [], _allAreas: data.areas ?? [], tasks: selectVisibleTasks(data.tasks),
        projects: data.projects.filter(row => !row.deletedAt && !row.purgedAt), areas: (data.areas ?? []).filter(row => !row.deletedAt), settings: data.settings });
    const check = (p: NativePreparedBoardOrder, authority: PreparedAreaAuthority): boolean => {
        const state = fromData(authority.snapshot); const live = snapshot(p.request.action.filters, p.request.action.status, new Date(), state);
        // Only adopted lossless RN hydration forms bridge raw BEFORE to the displayed scope.
        return Boolean(live && state.settings.deviceId === p.deviceIdBefore && same(live.filters, p.request.action.filters)
            && live.scope.columnTasks.length === p.scope.columnTasks.length
            && live.scope.columnTasks.every((row, index) => samePreparedBoardOrderBefore(row, p.scope.columnTasks[index]))
            && same({ ...live.scope, columnTasks: [] }, { ...p.scope, columnTasks: [] })
            && p.effect.tasks.every(pair => boardOrderWritable(pair.before, live.scope)));
    };
    let adapterOwner: NativeReceiptSqliteAdapter | null = null;
    const adapter = () => {
        if (!deps.readiness().ok) return null;
        const current = getStorageAdapter();
        if (!(current instanceof NativeReceiptSqliteAdapter) || !current.concurrentWritesGuarded || !isNativeRequestReceiptDurable('boardTaskOrder')) return null;
        if (adapterOwner === null) adapterOwner = current;
        return adapterOwner === current ? current : null;
    };
    const payload = (p: NativePreparedBoardOrder) => canonical(['boardTaskOrder', p]);
    const guard = createAreaSaveGuard(deps.save);
    let pending: { prepared: NativePreparedBoardOrder; adapter: NativeReceiptSqliteAdapter; boundary?: PreparedNativeSaveBoundary } | null = null;
    const apply = (p: NativePreparedBoardOrder, authority: PreparedAreaAuthority) => useTaskStore.getState().commitPreparedBoardOrder(p, authority, () => check(p, authority));
    const receipts = createNativeRequestReceipts({ save: async id => {
        const owed = pending;
        if (!owed || owed.prepared.request.requestId !== id) return fail('SAVE_FAILED', 'Board order has no owned save');
        if (useTaskStore.getState().persistenceFailure) {
            if (!guard.mayApply(owed.prepared, owed.adapter)) return fail('SAVE_FAILED', 'Board order has an unrelated persistence failure');
            const read = await readAreaDurableData(true, true); if (!read.ok) return read;
            if (read.value.adapter !== owed.adapter || !check(owed.prepared, read.value.authority)) return fail('STALE_REVISION', 'Board order retry dependencies changed');
            const result = await apply(owed.prepared, read.value.authority);
            if (!result.success || result.outcome !== 'applied') return fail('STALE_REVISION', 'Board order retry was superseded');
            owed.boundary = read.value.authority.saveBoundary;
        }
        const saved = await guard.finish(owed.prepared, owed.adapter, false, owed.boundary);
        if (saved.ok) pending = null;
        return saved;
    } });
    const outcome = async (p: NativePreparedBoardOrder): Promise<NativeHostResult<{ changed: true; open: null } | null>> => {
        const ready = deps.readiness(); if (!ready.ok) return ready;
        const owner = adapter(); const state = useTaskStore.getState(); const status = getPersistenceStatus();
        const settled = () => { const current = useTaskStore.getState(); const persistence = getPersistenceStatus(); return deps.readiness().ok
            && getStorageAdapter() === owner && !current.persistenceFailure && !persistence.queued && !persistence.inFlight && !persistence.immediate && !persistence.retrying
            && persistence.generation === status.generation && current._allTasks === state._allTasks && current._allProjects === state._allProjects
            && current._allSections === state._allSections && current._allAreas === state._allAreas && current._allPeople === state._allPeople
            && current.settings === state.settings && current.lastDataChangeAt === state.lastDataChangeAt; };
        if (!owner || !settled()) return fail('SAVE_FAILED', 'Board order saved outcome is unavailable');
        try {
            const data = await owner.getData({ rawTasks: true }); if (!settled()) return fail('STALE_REVISION', 'Board order changed during outcome read');
            const receipt = await owner.readDurableReceipt(p.request.requestId, payload(p), { committedOnly: true }); if (!receipt.ok) return receipt;
            const baseline = await owner.readRowBaseline(); if (!baseline || !settled()) return fail('STALE_REVISION', 'Board order durable proof changed');
            if (receipt.value === null) return { ok: true, value: null };
            if (!same(receipt.value, p.result)) return fail('INVALID_INPUT', 'Board order receipt result does not match');
            return { ok: true, value: p.effect.tasks.every(pair => { const rows = data.tasks.filter(row => row.id === pair.after.id);
                return rows.length === 1 && samePreparedBoardOrderTask(rows[0], pair.after); }) ? p.result : null };
        } catch { return fail('SAVE_FAILED', 'Board order outcome could not be read'); }
    };
    return {
        snapshot,
        readEnvelope,
        prepare(value: unknown): NativeHostResult<{ kind: 'prepared'; prepared: NativePreparedBoardOrder } | { kind: 'noop'; result: { changed: false; open: null } }> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const r = request(value); if (!r) return fail('INVALID_INPUT', 'A strict Board order request is required');
            const state = useTaskStore.getState(); const current = snapshot(r.action.filters, r.action.status, new Date(), state);
            const source = current?.scope.columnTasks.find(row => row.id === r.action.taskId);
            if (!current || !source || !same(current.filters, r.action.filters) || current.token !== r.action.expectedOrder
                || taskRevisionOf(source) !== r.action.taskRevision) return fail('STALE_REVISION', 'The Board order changed; read the Board again');
            if (!text(state.settings.deviceId) || !state.settings.deviceId.trim() || !boardOrderWritable(source, current.scope)
                || !current.scope.shownIds.includes(source.id) || r.action.afterId !== null && (r.action.afterId === source.id || !current.scope.shownIds.includes(r.action.afterId)))
                return fail('INVALID_INPUT', 'Board order needs a visible writable stored source and same-column anchor');
            try {
                const at = new Date().toISOString(); const effect = boardOrderEffect(r, current.scope, at, state.settings.deviceId);
                if (!effect.tasks.length) return { ok: true, value: { kind: 'noop', result: { changed: false, open: null } } };
                const p: NativePreparedBoardOrder = { version: 1, request: r, scope: current.scope, effect, deviceIdBefore: state.settings.deviceId,
                    preparedAt: at, result: { changed: true, open: null } };
                const envelope = readEnvelope(plain({ request: r, prepared: p }));
                return envelope ? { ok: true, value: { kind: 'prepared', prepared: envelope.prepared } } : fail('INVALID_INPUT', 'Board order effect is unsupported or exceeds its journal budget');
            } catch { return fail('INVALID_INPUT', 'Board order cannot be represented'); }
        },
        outcome(value: unknown) { const e = readEnvelope(value); return e ? outcome(e.prepared) : Promise.resolve(fail('INVALID_INPUT', 'A strict Board order envelope is required')); },
        async commit(value: unknown): Promise<NativeHostResult<{ changed: true; open: null }>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const e = readEnvelope(value); if (!e) return fail('INVALID_INPUT', 'A strict Board order envelope is required');
            const p = e.prepared; const owner = adapter(); if (!owner) return fail('SAVE_FAILED', 'Board order requires guarded durable receipt ownership');
            const saved = receipts.saved<{ changed: true; open: null }>(p.request.requestId, payload(p));
            if (saved) return saved.ok && same(saved.value, p.result) ? saved : saved.ok ? fail('INVALID_INPUT', 'Board order saved result differs') : saved;
            let failure: NativeHostResult<never> | null = null;
            const result = await receipts.run(p.request.requestId, payload(p), async () => {
                if (useTaskStore.getState().persistenceFailure) { failure = fail('SAVE_FAILED', 'Board order has an unresolved persistence failure'); return fail('ACTION_FAILED', 'Board order has an unresolved persistence failure'); }
                const read = await readAreaDurableData(false, true);
                if (!read.ok) { if (read.error.code === 'SAVE_FAILED') { failure = read; return fail('ACTION_FAILED', read.error.message); } return read; }
                if (read.value.adapter !== owner || !check(p, read.value.authority)) return fail('STALE_REVISION', 'Board order dependencies changed');
                const applied = await apply(p, read.value.authority); if (!applied.success || applied.outcome !== 'applied') return fail('STALE_REVISION', 'Board order atomic effect was superseded');
                pending = { prepared: p, adapter: owner, boundary: read.value.authority.saveBoundary };
                return { ok: true, value: p.result };
            });
            return failure ?? result;
        },
    };
}
