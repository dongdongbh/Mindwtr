import type { NativeHostResult } from './native-host-contract';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { taskEditValuesEqual } from './json-value-equality';
import { detach, exact, iso, record, validProject } from './native-host-contract-project-shared';
import { ensureDeviceId } from './store-helpers';
import { useTaskStore } from './store';
import { countFocusedLiveProjects, MAX_FOCUSED_PROJECTS, projectFocusEffect,
    projectFocusToggleUpdate, sameProjectSqliteRow } from './store-projects/project-actions';
import type { PreparedProjectFocus } from './store-types';
import type { Project } from './types';

export type NativeProjectFocusToken = { title: string; status: Project['status']; isFocused: boolean;
    rev: number | null; revBy: string | null; updatedAt: string };
export type NativeProjectFocusRequest = { requestId: string; projectId: string; focused: boolean;
    expected: NativeProjectFocusToken };
export type NativeProjectFocusResult = { id: string; focused: boolean };
export type NativePreparedProjectFocus = PreparedProjectFocus & { version: 1; request: NativeProjectFocusRequest;
    result: NativeProjectFocusResult };
export type NativeProjectFocusPreparation = { kind: 'noop'; result: NativeProjectFocusResult }
    | { kind: 'blocked'; result: { blocked: '' } }
    | { kind: 'prepared'; prepared: NativePreparedProjectFocus };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const same = taskEditValuesEqual;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const token = (project: Project): NativeProjectFocusToken => ({ title: project.title, status: project.status,
    isFocused: Boolean(project.isFocused), rev: project.rev ?? null, revBy: project.revBy ?? null,
    updatedAt: project.updatedAt });

const readRequest = (value: unknown): NativeProjectFocusRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    if (!input || !exact(input, ['requestId', 'projectId', 'focused', 'expected'])
        || typeof input.requestId !== 'string' || !UUID.test(input.requestId)
        || typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 500
        || typeof input.focused !== 'boolean' || !record(input.expected)
        || !exact(input.expected, ['title', 'status', 'isFocused', 'rev', 'revBy', 'updatedAt'])) return null;
    const expected = input.expected;
    return typeof expected.title === 'string' && expected.title.length <= 100_000
        && ['active', 'someday', 'waiting', 'archived'].includes(String(expected.status))
        && typeof expected.isFocused === 'boolean'
        && (expected.rev === null || typeof expected.rev === 'number'
            && Number.isSafeInteger(expected.rev) && expected.rev >= 0)
        && (expected.revBy === null || typeof expected.revBy === 'string' && expected.revBy.length <= 500)
        && iso(expected.updatedAt) ? input as NativeProjectFocusRequest : null;
};


const readPrepared = (value: unknown): NativePreparedProjectFocus | null => {
    const envelope = detach<Record<string, unknown>>(value);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'scope', 'effect', 'deviceIdBefore',
        'deviceIdToInitialize', 'updateAt', 'result']) || raw.version !== 1 || !same(raw.request, request)
        || !record(raw.scope) || !exact(raw.scope, ['project', 'focusedProjectCount'])
        || !record(raw.scope.project)
        || typeof raw.scope.focusedProjectCount !== 'number'
        || !Number.isSafeInteger(raw.scope.focusedProjectCount) || raw.scope.focusedProjectCount < 0
        || !record(raw.effect) || !exact(raw.effect, ['project']) || !record(raw.effect.project)
        || !exact(raw.effect.project, ['before', 'after'])
        || !(raw.deviceIdBefore === null || typeof raw.deviceIdBefore === 'string' && Boolean(raw.deviceIdBefore))
        || (raw.deviceIdBefore === null
            ? typeof raw.deviceIdToInitialize !== 'string' || !UUID.test(raw.deviceIdToInitialize)
            : raw.deviceIdToInitialize !== null)
        || !iso(raw.updateAt) || !record(raw.result) || !exact(raw.result, ['id', 'focused'])
        || raw.result.id !== request.projectId || raw.result.focused !== request.focused) return null;
    try {
        const prepared = raw as unknown as NativePreparedProjectFocus;
        const before = prepared.scope.project;
        if (!validProject(before, request.projectId)
            || !validProject(prepared.effect.project.before, request.projectId)
            || !validProject(prepared.effect.project.after, request.projectId)
            || typeof prepared.effect.project.after.isFocused !== 'boolean'
            || !same(token(before), request.expected)
            || !same(before, prepared.effect.project.before)) return null;
        const planned = projectFocusEffect(before, prepared.scope.focusedProjectCount, request.focused,
            prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, prepared.updateAt);
        return planned && same(planned, prepared.effect)
            && !sameProjectSqliteRow(before, planned.project.after) ? prepared : null;
    } catch { return null; }
};

export function createProjectFocusMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    revision: () => string;
}) {
    return {
        getProjectFocusOptions(input: { projectId: string }): NativeHostResult<{ revision: string;
            project: { id: string } & NativeProjectFocusToken; focusedProjectCount: number; limit: number }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!input || typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 500)
                return fail('INVALID_INPUT', 'A Project ID is required');
            const state = useTaskStore.getState();
            const project = state._projectsById.get(input.projectId);
            if (!project || project.deletedAt || project.purgedAt)
                return fail('STALE_REVISION', 'Project is unavailable; refresh before changing Focus');
            const value = { revision: deps.revision(), project: { id: project.id, ...token(project) },
                focusedProjectCount: countFocusedLiveProjects(state._allProjects), limit: MAX_FOCUSED_PROJECTS };
            return isNativeJsonWithinBytes(value) ? { ok: true, value }
                : fail('INVALID_INPUT', 'Project Focus options exceed the bounded native response');
        },

        probeProjectFocusOutcome(input: NativeProjectFocusRequest): NativeHostResult<NativeProjectFocusResult> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return readRequest(input) ? fail('STALE_REVISION', 'Project Focus outcome is unknown; refresh before trying again')
                : fail('INVALID_INPUT', 'A bounded Project Focus request is required');
        },

        prepareProjectFocus(input: NativeProjectFocusRequest): NativeHostResult<NativeProjectFocusPreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Project Focus request is required');
            const state = useTaskStore.getState();
            const project = state._projectsById.get(request.projectId);
            if (!project || project.deletedAt || project.purgedAt || !same(token(project), request.expected))
                return fail('STALE_REVISION', 'Project changed; refresh before changing Focus');
            if (Boolean(project.isFocused) === request.focused)
                return { ok: true, value: { kind: 'noop', result: { id: project.id, focused: request.focused } } };
            const focusedProjectCount = countFocusedLiveProjects(state._allProjects);
            if (!projectFocusToggleUpdate(project, focusedProjectCount))
                return { ok: true, value: { kind: 'blocked', result: { blocked: '' } } };
            const device = ensureDeviceId(state.settings);
            const updateAt = new Date().toISOString();
            const effect = projectFocusEffect(project, focusedProjectCount, request.focused, device.deviceId, updateAt);
            if (!effect) return fail('STALE_REVISION', 'Project Focus change is unavailable');
            const prepared: NativePreparedProjectFocus = { version: 1, request,
                scope: { project, focusedProjectCount }, effect,
                deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                updateAt, result: { id: project.id, focused: request.focused } };
            const frozen = detach<NativePreparedProjectFocus>(JSON.parse(JSON.stringify(prepared)));
            return frozen && readPrepared({ request, prepared: frozen })
                ? { ok: true, value: { kind: 'prepared', prepared: frozen } }
                : fail('INVALID_INPUT', 'Project Focus change exceeds the bounded journal');
        },

        validatePreparedProjectFocus(input: { request: NativeProjectFocusRequest;
            prepared: NativePreparedProjectFocus }): NativeHostResult<NativeProjectFocusResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result }
                : fail('INVALID_INPUT', 'Prepared Project Focus request or journal does not match');
        },

        async commitPreparedProjectFocus(input: { request: NativeProjectFocusRequest;
            prepared: NativePreparedProjectFocus }): Promise<NativeHostResult<NativeProjectFocusResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared Project Focus request or journal does not match');
            const applied = await useTaskStore.getState().commitPreparedProjectFocus(prepared);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared Project Focus conflicts with current data');
            try {
                if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            } catch (error) { return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error)); }
            const saved = await deps.save();
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
    };
}
