import type { NativeHostResult } from './native-host-contract';
import { taskEditValuesEqual } from './json-value-equality';
import { detach, exact, iso, record, validProject } from './native-host-contract-project-shared';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { ensureDeviceId } from './store-helpers';
import { useTaskStore } from './store';
import { projectStatusEffect, sameProjectSqliteRow } from './store-projects/project-actions';
import type { PreparedProjectStatus } from './store-types';
import type { Project } from './types';

export type NativeSelectableProjectStatus = 'active' | 'waiting' | 'someday';
export type NativeProjectStatusToken = { title: string; status: Project['status']; isFocused: boolean | null;
    cancelledAt: string | null; rev: number | null; revBy: string | null; updatedAt: string };
export type NativeProjectStatusRequest = { requestId: string; projectId: string; status: NativeSelectableProjectStatus;
    expected: NativeProjectStatusToken };
export type NativeProjectStatusResult = { id: string; status: NativeSelectableProjectStatus; isFocused: boolean | null };
export type NativePreparedProjectStatus = PreparedProjectStatus & { version: 1;
    request: NativeProjectStatusRequest; result: NativeProjectStatusResult };
export type NativeProjectStatusPreparation = { kind: 'noop'; result: NativeProjectStatusResult }
    | { kind: 'blocked'; result: { blocked: '' } }
    | { kind: 'prepared'; prepared: NativePreparedProjectStatus };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const same = taskEditValuesEqual;
const selectable = (status: unknown): status is NativeSelectableProjectStatus =>
    status === 'active' || status === 'waiting' || status === 'someday';
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const token = (project: Project): NativeProjectStatusToken => ({
    title: project.title, status: project.status, isFocused: project.isFocused ?? null,
    cancelledAt: project.cancelledAt ?? null, rev: project.rev ?? null,
    revBy: project.revBy ?? null, updatedAt: project.updatedAt,
});
const result = (project: Project): NativeProjectStatusResult => ({
    id: project.id, status: project.status as NativeSelectableProjectStatus,
    isFocused: project.isFocused ?? null,
});

const readRequest = (value: unknown): NativeProjectStatusRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    if (!input || !exact(input, ['requestId', 'projectId', 'status', 'expected'])
        || typeof input.requestId !== 'string' || !UUID.test(input.requestId)
        || typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 500
        || !selectable(input.status) || !record(input.expected)
        || !exact(input.expected, ['title', 'status', 'isFocused', 'cancelledAt', 'rev', 'revBy', 'updatedAt'])) return null;
    const expected = input.expected;
    return typeof expected.title === 'string' && expected.title.length <= 100_000
        && ['active', 'someday', 'waiting', 'archived'].includes(String(expected.status))
        && (expected.isFocused === null || typeof expected.isFocused === 'boolean')
        && (expected.cancelledAt === null || iso(expected.cancelledAt))
        && (expected.rev === null || typeof expected.rev === 'number'
            && Number.isSafeInteger(expected.rev) && expected.rev >= 0)
        && (expected.revBy === null || typeof expected.revBy === 'string' && expected.revBy.length <= 500)
        && iso(expected.updatedAt) ? input as NativeProjectStatusRequest : null;
};


const readPrepared = (value: unknown): NativePreparedProjectStatus | null => {
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
        || !iso(raw.updateAt) || !record(raw.result) || !exact(raw.result, ['id', 'status', 'isFocused'])
        || raw.result.id !== request.projectId || raw.result.status !== request.status
        || !(raw.result.isFocused === null || typeof raw.result.isFocused === 'boolean')) return null;
    try {
        const prepared = raw as unknown as NativePreparedProjectStatus;
        const before = prepared.scope.project;
        if (!validProject(before, request.projectId)
            || !validProject(prepared.effect.project.before, request.projectId)
            || !validProject(prepared.effect.project.after, request.projectId)
            || before.status === 'archived' || before.status === request.status
            || !same(token(before), request.expected)
            || !same(before, prepared.effect.project.before)) return null;
        const planned = projectStatusEffect(before, request.status,
            prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, prepared.updateAt);
        return same(planned, prepared.effect) && same(result(planned.project.after), prepared.result)
            && !sameProjectSqliteRow(before, planned.project.after) ? prepared : null;
    } catch { return null; }
};

export function createProjectStatusMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    revision: () => string;
}) {
    return {
        getProjectStatusOptions(input: { projectId: string }): NativeHostResult<{ revision: string;
            project: { id: string } & NativeProjectStatusToken; canChange: boolean }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!input || typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 500)
                return fail('INVALID_INPUT', 'A Project ID is required');
            const project = useTaskStore.getState()._projectsById.get(input.projectId);
            if (!project || project.deletedAt || project.purgedAt)
                return fail('STALE_REVISION', 'Project is unavailable; refresh before changing status');
            const value = { revision: deps.revision(), project: { id: project.id, ...token(project) },
                canChange: project.status !== 'archived' };
            return isNativeJsonWithinBytes(value) ? { ok: true, value }
                : fail('INVALID_INPUT', 'Project status options exceed the bounded native response');
        },

        probeProjectStatusOutcome(input: NativeProjectStatusRequest): NativeHostResult<NativeProjectStatusResult> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return readRequest(input) ? fail('STALE_REVISION', 'Project status outcome is unknown; refresh before trying again')
                : fail('INVALID_INPUT', 'A bounded Project status request is required');
        },

        prepareProjectStatus(input: NativeProjectStatusRequest): NativeHostResult<NativeProjectStatusPreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Project status request is required');
            const state = useTaskStore.getState();
            const project = state._projectsById.get(request.projectId);
            if (!project || project.deletedAt || project.purgedAt || !same(token(project), request.expected))
                return fail('STALE_REVISION', 'Project changed; refresh before changing status');
            if (project.status === 'archived')
                return { ok: true, value: { kind: 'blocked', result: { blocked: '' } } };
            if (project.status === request.status)
                return { ok: true, value: { kind: 'noop', result: result(project) } };
            const device = ensureDeviceId(state.settings);
            const updateAt = new Date().toISOString();
            const effect = projectStatusEffect(project, request.status, device.deviceId, updateAt);
            const prepared: NativePreparedProjectStatus = { version: 1, request,
                scope: { project }, effect,
                deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                updateAt, result: result(effect.project.after) };
            const frozen = detach<NativePreparedProjectStatus>(JSON.parse(JSON.stringify(prepared)));
            return frozen && readPrepared({ request, prepared: frozen })
                ? { ok: true, value: { kind: 'prepared', prepared: frozen } }
                : fail('INVALID_INPUT', 'Project status edit exceeds the bounded journal');
        },

        validatePreparedProjectStatus(input: { request: NativeProjectStatusRequest;
            prepared: NativePreparedProjectStatus }): NativeHostResult<NativeProjectStatusResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result }
                : fail('INVALID_INPUT', 'Prepared Project status request or journal does not match');
        },

        async commitPreparedProjectStatus(input: { request: NativeProjectStatusRequest;
            prepared: NativePreparedProjectStatus }): Promise<NativeHostResult<NativeProjectStatusResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared Project status request or journal does not match');
            const applied = await useTaskStore.getState().commitPreparedProjectStatus(prepared);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared Project status conflicts with current data');
            try {
                if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            } catch (error) { return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error)); }
            const saved = await deps.save();
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
    };
}
