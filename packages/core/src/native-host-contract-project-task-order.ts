import type { NativeHostResult } from './native-host-contract';
import { detach, exact, iso, record, validProject } from './native-host-contract-project-shared';
import { validSection } from './native-host-contract-project-section-rename';
import { readFilterState } from './native-host-contract-menu-views';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { getProjectSectionsForView } from './project-utils';
import { getProjectSyntheticSectionIds, sortProjectTasksByOrder } from './project-task-list-model';
import { projectTaskOrderToken } from './project-task-reorder';
import { resolveNonDoneTaskSortBy } from './task-list-sort-options';
import { getProjectFlowMode, resolveTaskSortByForFeatures } from './task-utils';
import { ensureDeviceId } from './store-helpers';
import { useTaskStore } from './store';
import { projectTaskOrderEffect } from './store-projects/ordering-actions';
import { sameSectionDeleteJson, sameTaskSqliteRow } from './store-projects/section-actions';
import { TASK_SYNC_FIELD_SCHEMA, taskToSqliteRow } from './task-sync-schema';
import type { PreparedProjectTaskOrder } from './store-types';
import type { Project, Task } from './types';

export type NativeProjectTaskOrderRequest = PreparedProjectTaskOrder['request'];
export type NativeProjectTaskOrderResult = PreparedProjectTaskOrder['result'];
export type NativePreparedProjectTaskOrder = PreparedProjectTaskOrder & { version: 1 };
export type NativeProjectTaskOrderPreparation =
    | { kind: 'prepared'; prepared: NativePreparedProjectTaskOrder }
    | { kind: 'noop'; result: NativeProjectTaskOrderResult };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const TASK_KEYS = new Set(TASK_SYNC_FIELD_SCHEMA.map((field) => field.name));
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const same = sameSectionDeleteJson;
const validParent = (value: unknown, id: string): value is Project => record(value)
    && validProject(Object.fromEntries(Object.entries(value).map(([key, part]) =>
        [key, part === null ? undefined : part])), id);
const validTask = (value: unknown, id: string, projectId: string): value is Task => {
    if (!record(value) || Object.keys(value).some((key) => !TASK_KEYS.has(key as keyof Task))) return false;
    const row = Object.fromEntries(Object.entries(value).map(([key, part]) =>
        [key, part === null ? undefined : part]));
    if (row.id !== id || row.projectId !== projectId || row.deletedAt !== undefined || row.purgedAt !== undefined
        || typeof row.title !== 'string' || !['inbox', 'next', 'waiting', 'someday', 'reference', 'done', 'archived'].includes(String(row.status))
        || !Array.isArray(row.tags) || !row.tags.every((tag) => typeof tag === 'string')
        || !Array.isArray(row.contexts) || !row.contexts.every((context) => typeof context === 'string')
        || !iso(row.createdAt) || !iso(row.updatedAt)
        || (row.sectionId !== undefined && typeof row.sectionId !== 'string')
        || (row.rev !== undefined && !(typeof row.rev === 'number' && Number.isSafeInteger(row.rev) && row.rev >= 0))
        || (row.revBy !== undefined && typeof row.revBy !== 'string')) return false;
    try { taskToSqliteRow(value as unknown as Task); return true; }
    catch { return false; }
};

const readRequest = (value: unknown): NativeProjectTaskOrderRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    if (!input || !exact(input, ['requestId', 'projectId', 'taskId', 'after', 'showCompleted', 'filters', 'expectedOrder'])
        || typeof input.requestId !== 'string' || !UUID.test(input.requestId)
        || typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 500
        || typeof input.taskId !== 'string' || !input.taskId || input.taskId.length > 500
        || !(input.after === null || record(input.after) && exact(input.after, ['type', 'id'])
            && (input.after.type === 'task' || input.after.type === 'section')
            && typeof input.after.id === 'string' && Boolean(input.after.id) && input.after.id.length <= 500)
        || typeof input.showCompleted !== 'boolean' || !record(input.filters)
        || typeof input.expectedOrder !== 'string' || !input.expectedOrder || !isNativeJsonWithinBytes(input.expectedOrder)) return null;
    const filters = readFilterState(input.filters);
    return filters && !filters.projects.length && !filters.timeEstimates.length
        ? input as NativeProjectTaskOrderRequest : null;
};

/** The frozen flat list may be filtered, but every row must be a real ordered subset of the source. */
const validItems = (scope: PreparedProjectTaskOrder['scope'], request: NativeProjectTaskOrderRequest): boolean => {
    const sectionIds = scope.sections.map((row) => row.id);
    const syntheticIds = getProjectSyntheticSectionIds(scope.sections);
    const live = new Set(sectionIds);
    const tasks = new Map(scope.tasks.map((row) => [row.id, row]));
    const seenTasks = new Set<string>();
    const headers: string[] = [];
    const buckets = new Map<string | null, Task[]>();
    let current: string | null = null;
    let sawHeader = false;
    let noSectionHeader = false;
    for (const item of scope.items) {
        if (!record(item) || typeof item.id !== 'string' || !item.id || item.id.length > 500) return false;
        if (item.type === 'section') {
            if (!exact(item, ['type', 'id', 'sectionId'])) return false;
            if (item.id === syntheticIds.none && item.sectionId === null) {
                if (noSectionHeader || headers.length !== sectionIds.length) return false;
                noSectionHeader = true;
            } else if (typeof item.sectionId === 'string' && item.sectionId === item.id && live.has(item.id)) {
                if (noSectionHeader || item.id !== sectionIds[headers.length]) return false;
                headers.push(item.id);
            } else return false;
            current = item.sectionId as string | null;
            sawHeader = true;
            continue;
        }
        if (item.type !== 'task' || !exact(item, ['type', 'id']) || seenTasks.has(item.id)) return false;
        const task = tasks.get(item.id);
        if (!task || task.status === 'reference'
            || (!request.showCompleted && (task.status === 'done' || task.status === 'archived'))
            || (request.showCompleted && getProjectFlowMode(scope.project) === 'parallel' && task.status === 'done')) return false;
        const bucket = task.sectionId && live.has(task.sectionId) ? task.sectionId : null;
        if (bucket !== current || sectionIds.length > 0 && !sawHeader) return false;
        seenTasks.add(task.id);
        const rows = buckets.get(bucket) ?? [];
        rows.push(task);
        buckets.set(bucket, rows);
    }
    if (headers.length !== sectionIds.length || noSectionHeader !== (sectionIds.length > 0
        ? (buckets.get(null)?.length ?? 0) > 0
        : scope.items.some((item) => item.type === 'task' && Boolean(tasks.get(item.id)?.sectionId)))) return false;
    for (const rows of buckets.values()) {
        const sorted = sortProjectTasksByOrder(rows).map((row) => row.id);
        if (!same(sorted, rows.map((row) => row.id))) return false;
    }
    return true;
};

/** Pure cold-journal validation before any mutable store or SQLite access. */
const readPrepared = (value: unknown): NativePreparedProjectTaskOrder | null => {
    const envelope = detach<Record<string, unknown>>(value);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'scope', 'effect', 'deviceIdBefore',
        'deviceIdToInitialize', 'preparedAt', 'result']) || raw.version !== 1 || !same(raw.request, request)
        || !record(raw.scope) || !exact(raw.scope, ['project', 'tasks', 'sections', 'settings', 'items'])
        || !Array.isArray(raw.scope.tasks) || !Array.isArray(raw.scope.sections)
        || !record(raw.scope.settings) || !Array.isArray(raw.scope.items)
        || !record(raw.effect) || !exact(raw.effect, ['tasks']) || !Array.isArray(raw.effect.tasks)
        || raw.effect.tasks.length === 0
        || !(raw.deviceIdBefore === null || typeof raw.deviceIdBefore === 'string' && Boolean(raw.deviceIdBefore))
        || (raw.deviceIdBefore === null
            ? typeof raw.deviceIdToInitialize !== 'string' || !UUID.test(raw.deviceIdToInitialize)
            : raw.deviceIdToInitialize !== null)
        || !iso(raw.preparedAt) || !record(raw.result) || !exact(raw.result, ['projectId', 'taskId', 'sectionId'])
        || raw.result.projectId !== request.projectId || raw.result.taskId !== request.taskId
        || !(raw.result.sectionId === null || typeof raw.result.sectionId === 'string')) return null;
    try {
        const prepared = raw as unknown as NativePreparedProjectTaskOrder;
        const { scope, effect } = prepared;
        if (!validParent(scope.project, request.projectId) || scope.project.status === 'archived'
            || resolveNonDoneTaskSortBy(resolveTaskSortByForFeatures(scope.project.taskSortBy ?? 'default', scope.settings), scope.settings) !== 'default'
            || !same(scope.settings.deviceId ?? null, prepared.deviceIdBefore)
            || scope.sections.some((row) => !validSection(row, row.id, request.projectId)
                || row.deletedAt || 'purgedAt' in row)
            || !same(getProjectSectionsForView(scope.project, scope.sections), scope.sections)
            || scope.tasks.some((row) => !validTask(row, row.id, request.projectId))
            || new Set(scope.tasks.map((row) => row.id)).size !== scope.tasks.length
            || scope.tasks.some((row, index) => index > 0 && scope.tasks[index - 1].id >= row.id)
            || !validItems(scope, request)
            || projectTaskOrderToken({ project: scope.project, sections: scope.sections, tasks: scope.tasks,
                sortBy: 'default', items: scope.items }) !== request.expectedOrder) return null;
        const planned = projectTaskOrderEffect(scope, request,
            prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, prepared.preparedAt);
        if (!planned || !same(planned, { effect, result: prepared.result })
            || planned.effect.tasks.length !== effect.tasks.length) return null;
        return effect.tasks.every(({ before, after }, index) => {
            const expected = planned.effect.tasks[index];
            return validTask(before, before.id, request.projectId) && validTask(after, after.id, request.projectId)
                && sameTaskSqliteRow(before, expected.before) && sameTaskSqliteRow(after, expected.after);
        }) ? prepared : null;
    } catch { return null; }
};

export function createProjectTaskOrderMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    snapshot: (projectId: string, showCompleted: boolean, filters: NativeProjectTaskOrderRequest['filters']) =>
        { canReorder: boolean; token: string | null; scope: PreparedProjectTaskOrder['scope'] } | null;
}) {
    return {
        probeProjectTaskOrderOutcome(input: NativeProjectTaskOrderRequest): NativeHostResult<NativeProjectTaskOrderResult> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return readRequest(input) ? fail('STALE_REVISION', 'Project task order outcome is unknown')
                : fail('INVALID_INPUT', 'A bounded Project task order request is required');
        },

        prepareProjectTaskOrder(input: NativeProjectTaskOrderRequest): NativeHostResult<NativeProjectTaskOrderPreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Project task order request is required');
            const current = deps.snapshot(request.projectId, request.showCompleted, request.filters);
            if (!current || !current.canReorder || current.token !== request.expectedOrder)
                return fail('STALE_REVISION', 'Project task order changed; refresh before moving');
            const device = ensureDeviceId(current.scope.settings);
            const preparedAt = new Date().toISOString();
            const planned = projectTaskOrderEffect(current.scope, request, device.deviceId, preparedAt);
            if (!planned) return fail('INVALID_INPUT', 'Task or anchor is outside the Project order');
            if (planned.effect.tasks.length === 0) return { ok: true, value: { kind: 'noop', result: planned.result } };
            const prepared: NativePreparedProjectTaskOrder = { version: 1, request, scope: current.scope,
                effect: planned.effect, deviceIdBefore: current.scope.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                preparedAt, result: planned.result };
            const frozen = detach<NativePreparedProjectTaskOrder>(JSON.parse(JSON.stringify(prepared)));
            return frozen && readPrepared({ request, prepared: frozen })
                ? { ok: true, value: { kind: 'prepared', prepared: frozen } }
                : fail('INVALID_INPUT', 'Project task order exceeds the bounded journal');
        },

        validatePreparedProjectTaskOrder(input: { request: NativeProjectTaskOrderRequest;
            prepared: NativePreparedProjectTaskOrder }): NativeHostResult<NativeProjectTaskOrderResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result }
                : fail('INVALID_INPUT', 'Prepared Project task order request or journal does not match');
        },

        async commitPreparedProjectTaskOrder(input: { request: NativeProjectTaskOrderRequest;
            prepared: NativePreparedProjectTaskOrder }): Promise<NativeHostResult<NativeProjectTaskOrderResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared Project task order request or journal does not match');
            const applied = await useTaskStore.getState().commitPreparedProjectTaskOrder(prepared);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared Project task order conflicts with current data');
            try {
                if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            } catch (error) { return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error)); }
            const saved = await deps.save();
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
    };
}
