import type { NativeHostResult } from './native-host-contract';
import { taskEditValuesEqual } from './json-value-equality';
import { detach, exact, iso, record, validProject } from './native-host-contract-project-shared';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { ensureDeviceId } from './store-helpers';
import { useTaskStore } from './store';
import { projectFlowEffect, sameProjectSqliteRow } from './store-projects/project-actions';
import type { PreparedProjectFlow, ProjectFlowAction } from './store-types';
import { getProjectFlowMode } from './task-utils';
import type { Project, ProjectFlowMode } from './types';

export type NativeProjectFlowToken = { title: string; status: Project['status'];
    isSequential: boolean | null; sequentialScope: 'project' | 'section' | null;
    rev: number | null; revBy: string | null; updatedAt: string };
export type NativeProjectFlowRequest = { requestId: string; projectId: string;
    action: ProjectFlowAction; expected: NativeProjectFlowToken };
export type NativeProjectFlowResult = { id: string; isSequential: boolean;
    sequentialScope: 'project' | 'section' | null };
export type NativePreparedProjectFlow = PreparedProjectFlow & { version: 1; request: NativeProjectFlowRequest;
    result: NativeProjectFlowResult };
export type NativeProjectFlowPreparation = { kind: 'noop'; result: NativeProjectFlowResult }
    | { kind: 'blocked'; result: { blocked: '' } }
    | { kind: 'prepared'; prepared: NativePreparedProjectFlow };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const same = taskEditValuesEqual;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const token = (project: Project): NativeProjectFlowToken => ({
    title: project.title, status: project.status,
    isSequential: project.isSequential ?? null, sequentialScope: project.sequentialScope ?? null,
    rev: project.rev ?? null, revBy: project.revBy ?? null, updatedAt: project.updatedAt,
});
const result = (project: Project): NativeProjectFlowResult => ({
    id: project.id, isSequential: project.isSequential ?? false,
    sequentialScope: project.sequentialScope ?? null,
});

const readRequest = (value: unknown): NativeProjectFlowRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    if (!input || !exact(input, ['requestId', 'projectId', 'action', 'expected'])
        || typeof input.requestId !== 'string' || !UUID.test(input.requestId)
        || typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 500
        || !record(input.action) || !record(input.expected)
        || !exact(input.expected, ['title', 'status', 'isSequential', 'sequentialScope',
            'rev', 'revBy', 'updatedAt'])) return null;
    const action = input.action;
    if (!(action.kind === 'toggleType' && exact(action, ['kind'])
        || action.kind === 'setScope' && exact(action, ['kind', 'scope'])
            && (action.scope === 'project' || action.scope === 'section'))) return null;
    const expected = input.expected;
    return typeof expected.title === 'string' && expected.title.length <= 100_000
        && ['active', 'someday', 'waiting', 'archived'].includes(String(expected.status))
        && (expected.isSequential === null || typeof expected.isSequential === 'boolean')
        && (expected.sequentialScope === null || expected.sequentialScope === 'project'
            || expected.sequentialScope === 'section')
        && (expected.rev === null || typeof expected.rev === 'number'
            && Number.isSafeInteger(expected.rev) && expected.rev >= 0)
        && (expected.revBy === null || typeof expected.revBy === 'string' && expected.revBy.length <= 500)
        && iso(expected.updatedAt) ? input as NativeProjectFlowRequest : null;
};

/** Pure cold-journal validation before SQLite opens. */
const readPrepared = (value: unknown): NativePreparedProjectFlow | null => {
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
        || !exact(raw.result, ['id', 'isSequential', 'sequentialScope'])) return null;
    try {
        const prepared = raw as unknown as NativePreparedProjectFlow;
        const before = prepared.scope.project;
        if (!validProject(before, request.projectId)
            || !validProject(prepared.effect.project.before, request.projectId)
            || !validProject(prepared.effect.project.after, request.projectId)
            || before.status === 'archived'
            || !same(token(before), request.expected)
            || !same(before, prepared.effect.project.before)) return null;
        const planned = projectFlowEffect(before, request.action,
            prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, prepared.updateAt);
        return planned && same(planned, prepared.effect)
            && same(result(planned.project.after), prepared.result)
            && !sameProjectSqliteRow(before, planned.project.after) ? prepared : null;
    } catch { return null; }
};

export function createProjectFlowMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    revision: () => string;
}) {
    return {
        getProjectFlowOptions(input: { projectId: string }): NativeHostResult<{ revision: string;
            project: { id: string } & NativeProjectFlowToken; canChange: boolean; flowMode: ProjectFlowMode }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!input || typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 500)
                return fail('INVALID_INPUT', 'A Project ID is required');
            const project = useTaskStore.getState()._projectsById.get(input.projectId);
            if (!project || project.deletedAt || project.purgedAt)
                return fail('STALE_REVISION', 'Project is unavailable; refresh before changing flow');
            const value = { revision: deps.revision(), project: { id: project.id, ...token(project) },
                canChange: project.status !== 'archived', flowMode: getProjectFlowMode(project) };
            return isNativeJsonWithinBytes(value) ? { ok: true, value }
                : fail('INVALID_INPUT', 'Project flow options exceed the bounded native response');
        },

        probeProjectFlowOutcome(input: NativeProjectFlowRequest): NativeHostResult<NativeProjectFlowResult> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return readRequest(input) ? fail('STALE_REVISION', 'Project flow outcome is unknown; refresh before trying again')
                : fail('INVALID_INPUT', 'A bounded Project flow request is required');
        },

        prepareProjectFlow(input: NativeProjectFlowRequest): NativeHostResult<NativeProjectFlowPreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Project flow request is required');
            const state = useTaskStore.getState();
            const project = state._projectsById.get(request.projectId);
            if (!project || project.deletedAt || project.purgedAt || !same(token(project), request.expected))
                return fail('STALE_REVISION', 'Project changed; refresh before changing flow');
            if (project.status === 'archived'
                || request.action.kind === 'setScope' && !project.isSequential)
                return { ok: true, value: { kind: 'blocked', result: { blocked: '' } } };
            if (request.action.kind === 'setScope' && project.sequentialScope === request.action.scope)
                return { ok: true, value: { kind: 'noop', result: result(project) } };
            const device = ensureDeviceId(state.settings);
            const updateAt = new Date().toISOString();
            const effect = projectFlowEffect(project, request.action, device.deviceId, updateAt);
            if (!effect) return fail('INVALID_INPUT', 'Project flow action has no prepared effect');
            const prepared: NativePreparedProjectFlow = { version: 1, request,
                scope: { project }, effect,
                deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                updateAt, result: result(effect.project.after) };
            const frozen = detach<NativePreparedProjectFlow>(JSON.parse(JSON.stringify(prepared)));
            return frozen && readPrepared({ request, prepared: frozen })
                ? { ok: true, value: { kind: 'prepared', prepared: frozen } }
                : fail('INVALID_INPUT', 'Project flow exceeds the bounded journal');
        },

        validatePreparedProjectFlow(input: { request: NativeProjectFlowRequest;
            prepared: NativePreparedProjectFlow }): NativeHostResult<NativeProjectFlowResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result }
                : fail('INVALID_INPUT', 'Prepared Project flow request or journal does not match');
        },

        async commitPreparedProjectFlow(input: { request: NativeProjectFlowRequest;
            prepared: NativePreparedProjectFlow }): Promise<NativeHostResult<NativeProjectFlowResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared Project flow request or journal does not match');
            const applied = await useTaskStore.getState().commitPreparedProjectFlow(prepared);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared Project flow conflicts with current data');
            try {
                if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            } catch (error) { return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error)); }
            const saved = await deps.save();
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
    };
}
