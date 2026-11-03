import type { NativeHostResult } from './native-host-contract';
import { taskEditValuesEqual } from './json-value-equality';
import { detach, exact, iso, record, validProject } from './native-host-contract-project-shared';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { ensureDeviceId } from './store-helpers';
import { useTaskStore } from './store';
import { normalizeProjectRenameTitle, projectRenameEffect, sameProjectSqliteRow } from './store-projects/project-actions';
import type { PreparedProjectRename } from './store-types';
import type { Project } from './types';

export type NativeProjectRenameToken = { title: string; status: Project['status'];
    rev: number | null; revBy: string | null; updatedAt: string };
export type NativeProjectRenameRequest = { requestId: string; projectId: string; title: string;
    expected: NativeProjectRenameToken };
export type NativeProjectRenameResult = { id: string; title: string };
export type NativePreparedProjectRename = PreparedProjectRename & { version: 1; request: NativeProjectRenameRequest;
    result: NativeProjectRenameResult };
export type NativeProjectRenamePreparation = { kind: 'noop'; result: NativeProjectRenameResult }
    | { kind: 'blocked'; result: { blocked: '' } }
    | { kind: 'prepared'; prepared: NativePreparedProjectRename };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const same = taskEditValuesEqual;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const token = (project: Project): NativeProjectRenameToken => ({ title: project.title, status: project.status,
    rev: project.rev ?? null, revBy: project.revBy ?? null, updatedAt: project.updatedAt });

const readRequest = (value: unknown): NativeProjectRenameRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    if (!input || !exact(input, ['requestId', 'projectId', 'title', 'expected'])
        || typeof input.requestId !== 'string' || !UUID.test(input.requestId)
        || typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 500
        || typeof input.title !== 'string' || input.title.length > 100_000
        || !record(input.expected)
        || !exact(input.expected, ['title', 'status', 'rev', 'revBy', 'updatedAt'])) return null;
    const expected = input.expected;
    return typeof expected.title === 'string' && expected.title.length <= 100_000
        && ['active', 'someday', 'waiting', 'archived'].includes(String(expected.status))
        && (expected.rev === null || typeof expected.rev === 'number'
            && Number.isSafeInteger(expected.rev) && expected.rev >= 0)
        && (expected.revBy === null || typeof expected.revBy === 'string' && expected.revBy.length <= 500)
        && iso(expected.updatedAt) ? input as NativeProjectRenameRequest : null;
};


const readPrepared = (value: unknown): NativePreparedProjectRename | null => {
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
        || !iso(raw.updateAt) || !record(raw.result) || !exact(raw.result, ['id', 'title'])
        || raw.result.id !== request.projectId || raw.result.title !== normalizeProjectRenameTitle(request.title)) return null;
    try {
        const prepared = raw as unknown as NativePreparedProjectRename;
        const before = prepared.scope.project;
        const normalized = normalizeProjectRenameTitle(request.title);
        if (!validProject(before, request.projectId)
            || !validProject(prepared.effect.project.before, request.projectId)
            || !validProject(prepared.effect.project.after, request.projectId)
            || before.status === 'archived' || !normalized || normalized === before.title
            || !same(token(before), request.expected)
            || !same(before, prepared.effect.project.before)) return null;
        const planned = projectRenameEffect(before, normalized,
            prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, prepared.updateAt);
        return same(planned, prepared.effect)
            && !sameProjectSqliteRow(before, planned.project.after) ? prepared : null;
    } catch { return null; }
};

export function createProjectRenameMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    revision: () => string;
}) {
    return {
        getProjectRenameOptions(input: { projectId: string }): NativeHostResult<{ revision: string;
            project: { id: string } & NativeProjectRenameToken; canRename: boolean }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!input || typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 500)
                return fail('INVALID_INPUT', 'A Project ID is required');
            const project = useTaskStore.getState()._projectsById.get(input.projectId);
            if (!project || project.deletedAt || project.purgedAt)
                return fail('STALE_REVISION', 'Project is unavailable; refresh before renaming');
            const value = { revision: deps.revision(), project: { id: project.id, ...token(project) },
                canRename: project.status !== 'archived' };
            return isNativeJsonWithinBytes(value) ? { ok: true, value }
                : fail('INVALID_INPUT', 'Project rename options exceed the bounded native response');
        },

        probeProjectRenameOutcome(input: NativeProjectRenameRequest): NativeHostResult<NativeProjectRenameResult> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return readRequest(input) ? fail('STALE_REVISION', 'Project rename outcome is unknown; refresh before trying again')
                : fail('INVALID_INPUT', 'A bounded Project rename request is required');
        },

        prepareProjectRename(input: NativeProjectRenameRequest): NativeHostResult<NativeProjectRenamePreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Project rename request is required');
            const state = useTaskStore.getState();
            const project = state._projectsById.get(request.projectId);
            if (!project || project.deletedAt || project.purgedAt || !same(token(project), request.expected))
                return fail('STALE_REVISION', 'Project changed; refresh before renaming');
            if (project.status === 'archived')
                return { ok: true, value: { kind: 'blocked', result: { blocked: '' } } };
            const title = normalizeProjectRenameTitle(request.title);
            if (!title || title === project.title)
                return { ok: true, value: { kind: 'noop', result: { id: project.id, title: project.title } } };
            const device = ensureDeviceId(state.settings);
            const updateAt = new Date().toISOString();
            const prepared: NativePreparedProjectRename = { version: 1, request,
                scope: { project }, effect: projectRenameEffect(project, title, device.deviceId, updateAt),
                deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                updateAt, result: { id: project.id, title } };
            const frozen = detach<NativePreparedProjectRename>(JSON.parse(JSON.stringify(prepared)));
            return frozen && readPrepared({ request, prepared: frozen })
                ? { ok: true, value: { kind: 'prepared', prepared: frozen } }
                : fail('INVALID_INPUT', 'Project rename exceeds the bounded journal');
        },

        validatePreparedProjectRename(input: { request: NativeProjectRenameRequest;
            prepared: NativePreparedProjectRename }): NativeHostResult<NativeProjectRenameResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result }
                : fail('INVALID_INPUT', 'Prepared Project rename request or journal does not match');
        },

        async commitPreparedProjectRename(input: { request: NativeProjectRenameRequest;
            prepared: NativePreparedProjectRename }): Promise<NativeHostResult<NativeProjectRenameResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared Project rename request or journal does not match');
            const applied = await useTaskStore.getState().commitPreparedProjectRename(prepared);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared Project rename conflicts with current data');
            try {
                if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            } catch (error) { return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error)); }
            const saved = await deps.save();
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
    };
}
