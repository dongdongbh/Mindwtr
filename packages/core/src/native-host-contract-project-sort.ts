import type { NativeHostResult } from './native-host-contract';
import { taskEditValuesEqual } from './json-value-equality';
import { detach, exact, iso, record, validProject } from './native-host-contract-project-shared';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { normalizeProjectTaskSortBy } from './project-utils';
import { resolveFeatureFlags } from './resolve-feature-flags';
import { ensureDeviceId } from './store-helpers';
import { useTaskStore } from './store';
import { projectTaskSortEffect, sameProjectSqliteRow } from './store-projects/project-actions';
import { getVisibleTaskSortOptions, PROJECT_TASK_SORT_OPTIONS, resolveNonDoneTaskSortBy } from './task-list-sort-options';
import type { PreparedProjectTaskSort } from './store-types';
import type { Project, TaskSortBy } from './types';

export type NativeProjectTaskSortToken = { title: string; status: Project['status']; taskSortBy: TaskSortBy | null;
    rev: number | null; revBy: string | null; updatedAt: string };
export type NativeProjectTaskSortRequest = { requestId: string; projectId: string; sortBy: TaskSortBy;
    expected: NativeProjectTaskSortToken };
export type NativeProjectTaskSortResult = { id: string; taskSortBy: TaskSortBy | null };
export type NativePreparedProjectTaskSort = PreparedProjectTaskSort & { version: 1;
    request: NativeProjectTaskSortRequest; result: NativeProjectTaskSortResult };
export type NativeProjectTaskSortPreparation = { kind: 'noop'; result: NativeProjectTaskSortResult }
    | { kind: 'blocked'; result: { blocked: '' } }
    | { kind: 'prepared'; prepared: NativePreparedProjectTaskSort };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const same = taskEditValuesEqual;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const token = (project: Project): NativeProjectTaskSortToken => ({
    title: project.title, status: project.status, taskSortBy: normalizeProjectTaskSortBy(project.taskSortBy) ?? null,
    rev: project.rev ?? null, revBy: project.revBy ?? null, updatedAt: project.updatedAt,
});
const result = (project: Project): NativeProjectTaskSortResult => ({
    id: project.id, taskSortBy: normalizeProjectTaskSortBy(project.taskSortBy) ?? null,
});

const readRequest = (value: unknown): NativeProjectTaskSortRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    if (!input || !exact(input, ['requestId', 'projectId', 'sortBy', 'expected'])
        || typeof input.requestId !== 'string' || !UUID.test(input.requestId)
        || typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 500
        || !PROJECT_TASK_SORT_OPTIONS.includes(input.sortBy as TaskSortBy)
        || !record(input.expected)
        || !exact(input.expected, ['title', 'status', 'taskSortBy', 'rev', 'revBy', 'updatedAt'])) return null;
    const expected = input.expected;
    return typeof expected.title === 'string' && expected.title.length <= 100_000
        && ['active', 'someday', 'waiting', 'archived'].includes(String(expected.status))
        && (expected.taskSortBy === null || typeof expected.taskSortBy === 'string'
            && normalizeProjectTaskSortBy(expected.taskSortBy) === expected.taskSortBy)
        && (expected.rev === null || typeof expected.rev === 'number'
            && Number.isSafeInteger(expected.rev) && expected.rev >= 0)
        && (expected.revBy === null || typeof expected.revBy === 'string' && expected.revBy.length <= 500)
        && iso(expected.updatedAt) ? input as NativeProjectTaskSortRequest : null;
};

/** Pure cold-journal validation before SQLite opens. */
const readPrepared = (value: unknown): NativePreparedProjectTaskSort | null => {
    const envelope = detach<Record<string, unknown>>(value);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'scope', 'effect', 'deviceIdBefore',
        'deviceIdToInitialize', 'updateAt', 'result']) || raw.version !== 1 || !same(raw.request, request)
        || !record(raw.scope) || !exact(raw.scope, ['project']) || !record(raw.scope.project)
        || !record(raw.effect) || !exact(raw.effect, ['project']) || !record(raw.effect.project)
        || !exact(raw.effect.project, ['before', 'after'])
        || !(raw.deviceIdBefore === null || typeof raw.deviceIdBefore === 'string' && Boolean(raw.deviceIdBefore))
        || (raw.deviceIdBefore === null
            ? typeof raw.deviceIdToInitialize !== 'string' || !UUID.test(raw.deviceIdToInitialize)
            : raw.deviceIdToInitialize !== null)
        || !iso(raw.updateAt) || !record(raw.result)
        || !exact(raw.result, ['id', 'taskSortBy'])) return null;
    try {
        const prepared = raw as unknown as NativePreparedProjectTaskSort;
        const before = prepared.scope.project;
        if (!validProject(before, request.projectId)
            || !validProject(prepared.effect.project.before, request.projectId)
            || !validProject(prepared.effect.project.after, request.projectId)
            || before.status === 'archived'
            || !same(token(before), request.expected)
            || !same(before, prepared.effect.project.before)) return null;
        const planned = projectTaskSortEffect(before, request.sortBy,
            prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, prepared.updateAt);
        return planned && same(planned, prepared.effect)
            && same(result(planned.project.after), prepared.result)
            && !sameProjectSqliteRow(before, planned.project.after) ? prepared : null;
    } catch { return null; }
};

export function createProjectTaskSortMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    revision: () => string;
    t: (key: string) => string;
}) {
    return {
        getProjectTaskSortOptions(input: { projectId: string }): NativeHostResult<{ revision: string;
            project: { id: string } & NativeProjectTaskSortToken; canEdit: boolean;
            effectiveSortBy: TaskSortBy; choices: Array<{ id: TaskSortBy; label: string; selected: boolean }>;
            label: string }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!input || typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 500)
                return fail('INVALID_INPUT', 'A Project ID is required');
            const state = useTaskStore.getState();
            const project = state._projectsById.get(input.projectId);
            if (!project || project.deletedAt || project.purgedAt)
                return fail('STALE_REVISION', 'Project is unavailable; refresh before changing task sort');
            const effectiveSortBy = resolveNonDoneTaskSortBy(project.taskSortBy, state.settings);
            const value = { revision: deps.revision(), project: { id: project.id, ...token(project) },
                canEdit: project.status !== 'archived', effectiveSortBy,
                choices: getVisibleTaskSortOptions(PROJECT_TASK_SORT_OPTIONS, state.settings)
                    .map((id) => ({ id, label: deps.t(`sort.${id}`), selected: id === effectiveSortBy })),
                label: deps.t('sort.label') };
            return isNativeJsonWithinBytes(value) ? { ok: true, value }
                : fail('INVALID_INPUT', 'Project task sort options exceed the bounded native response');
        },

        probeProjectTaskSortOutcome(input: NativeProjectTaskSortRequest): NativeHostResult<NativeProjectTaskSortResult> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return readRequest(input) ? fail('STALE_REVISION', 'Project task sort outcome is unknown; refresh before trying again')
                : fail('INVALID_INPUT', 'A bounded Project task sort request is required');
        },

        prepareProjectTaskSort(input: NativeProjectTaskSortRequest): NativeHostResult<NativeProjectTaskSortPreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Project task sort request is required');
            const state = useTaskStore.getState();
            const project = state._projectsById.get(request.projectId);
            if (!project || project.deletedAt || project.purgedAt || !same(token(project), request.expected))
                return fail('STALE_REVISION', 'Project changed; refresh before changing task sort');
            if (project.status === 'archived'
                || request.sortBy === 'timeEstimate' && !resolveFeatureFlags(state.settings).timeEstimates)
                return { ok: true, value: { kind: 'blocked', result: { blocked: '' } } };
            if (normalizeProjectTaskSortBy(project.taskSortBy) === normalizeProjectTaskSortBy(request.sortBy))
                return { ok: true, value: { kind: 'noop', result: result(project) } };
            const device = ensureDeviceId(state.settings);
            const updateAt = new Date().toISOString();
            const effect = projectTaskSortEffect(project, request.sortBy, device.deviceId, updateAt);
            if (!effect) return fail('INVALID_INPUT', 'Project task sort has no prepared effect');
            const prepared: NativePreparedProjectTaskSort = { version: 1, request,
                scope: { project }, effect,
                deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                updateAt, result: result(effect.project.after) };
            const frozen = detach<NativePreparedProjectTaskSort>(JSON.parse(JSON.stringify(prepared)));
            return frozen && readPrepared({ request, prepared: frozen })
                ? { ok: true, value: { kind: 'prepared', prepared: frozen } }
                : fail('INVALID_INPUT', 'Project task sort exceeds the bounded journal');
        },

        validatePreparedProjectTaskSort(input: { request: NativeProjectTaskSortRequest;
            prepared: NativePreparedProjectTaskSort }): NativeHostResult<NativeProjectTaskSortResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result }
                : fail('INVALID_INPUT', 'Prepared Project task sort request or journal does not match');
        },

        async commitPreparedProjectTaskSort(input: { request: NativeProjectTaskSortRequest;
            prepared: NativePreparedProjectTaskSort }): Promise<NativeHostResult<NativeProjectTaskSortResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared Project task sort request or journal does not match');
            const applied = await useTaskStore.getState().commitPreparedProjectTaskSort(prepared);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared Project task sort conflicts with current data');
            try {
                if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            } catch (error) { return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error)); }
            const saved = await deps.save();
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
    };
}
