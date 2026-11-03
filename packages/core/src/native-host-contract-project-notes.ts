import type { NativeHostResult } from './native-host-contract';
import { taskEditValuesEqual } from './json-value-equality';
import { detach, exact, iso, record, validProject } from './native-host-contract-project-shared';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { ensureDeviceId } from './store-helpers';
import { useTaskStore } from './store';
import { isProjectNotesWriteNoop, projectNotesWriteEffect, sameProjectSqliteRow } from './store-projects/project-actions';
import type { PreparedProjectNotesWrite } from './store-types';
import type { Project } from './types';

export type NativeProjectNotesWriteToken = { title: string; status: Project['status'];
    supportNotes: string | null; rev: number | null; revBy: string | null; updatedAt: string };
export type NativeProjectNotesWriteRequest = { requestId: string; projectId: string; text: string;
    expected: NativeProjectNotesWriteToken };
export type NativeProjectNotesWriteResult = { id: string; supportNotes: string | null };
export type NativePreparedProjectNotesWrite = PreparedProjectNotesWrite & { version: 1;
    request: NativeProjectNotesWriteRequest; result: NativeProjectNotesWriteResult };
export type NativeProjectNotesWritePreparation = { kind: 'noop'; result: NativeProjectNotesWriteResult }
    | { kind: 'blocked'; result: { blocked: '' } }
    | { kind: 'prepared'; prepared: NativePreparedProjectNotesWrite };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const same = taskEditValuesEqual;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const token = (project: Project): NativeProjectNotesWriteToken => ({
    title: project.title, status: project.status, supportNotes: project.supportNotes ?? null,
    rev: project.rev ?? null, revBy: project.revBy ?? null, updatedAt: project.updatedAt,
});
const result = (project: Project): NativeProjectNotesWriteResult => ({
    id: project.id, supportNotes: project.supportNotes ?? null,
});

const readRequest = (value: unknown): NativeProjectNotesWriteRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    if (!input || !exact(input, ['requestId', 'projectId', 'text', 'expected'])
        || typeof input.requestId !== 'string' || !UUID.test(input.requestId)
        || typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 500
        || typeof input.text !== 'string' || !record(input.expected)
        || !exact(input.expected, ['title', 'status', 'supportNotes', 'rev', 'revBy', 'updatedAt'])) return null;
    const expected = input.expected;
    return typeof expected.title === 'string' && expected.title.length <= 100_000
        && ['active', 'someday', 'waiting', 'archived'].includes(String(expected.status))
        && (expected.supportNotes === null || typeof expected.supportNotes === 'string')
        && (expected.rev === null || typeof expected.rev === 'number'
            && Number.isSafeInteger(expected.rev) && expected.rev >= 0)
        && (expected.revBy === null || typeof expected.revBy === 'string' && expected.revBy.length <= 500)
        && iso(expected.updatedAt) ? input as NativeProjectNotesWriteRequest : null;
};


const readPrepared = (value: unknown): NativePreparedProjectNotesWrite | null => {
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
        || !iso(raw.updateAt) || !record(raw.result) || !exact(raw.result, ['id', 'supportNotes'])
        || raw.result.id !== request.projectId || raw.result.supportNotes !== request.text) return null;
    try {
        const prepared = raw as unknown as NativePreparedProjectNotesWrite;
        const before = prepared.scope.project;
        if (!validProject(before, request.projectId)
            || !validProject(prepared.effect.project.before, request.projectId)
            || !validProject(prepared.effect.project.after, request.projectId)
            || before.status === 'archived' || isProjectNotesWriteNoop(before, request.text)
            || !same(token(before), request.expected)
            || !same(before, prepared.effect.project.before)) return null;
        const planned = projectNotesWriteEffect(before, request.text,
            prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, prepared.updateAt);
        return same(planned, prepared.effect)
            && same(result(planned.project.after), prepared.result)
            && !sameProjectSqliteRow(before, planned.project.after) ? prepared : null;
    } catch { return null; }
};

export function createProjectNotesWriteMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    revision: () => string;
}) {
    return {
        getProjectNotesEditOptions(input: { projectId: string }): NativeHostResult<{ revision: string;
            project: { id: string } & NativeProjectNotesWriteToken; canEdit: boolean }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!input || typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 500)
                return fail('INVALID_INPUT', 'A Project ID is required');
            const project = useTaskStore.getState()._projectsById.get(input.projectId);
            if (!project || project.deletedAt || project.purgedAt)
                return fail('STALE_REVISION', 'Project is unavailable; refresh before editing Notes');
            const value = { revision: deps.revision(), project: { id: project.id, ...token(project) },
                canEdit: project.status !== 'archived' };
            return isNativeJsonWithinBytes(value) ? { ok: true, value }
                : fail('INVALID_INPUT', 'Project Notes options exceed the bounded native response');
        },

        probeProjectNotesWriteOutcome(input: NativeProjectNotesWriteRequest): NativeHostResult<NativeProjectNotesWriteResult> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return readRequest(input) ? fail('STALE_REVISION', 'Project Notes outcome is unknown; refresh before trying again')
                : fail('INVALID_INPUT', 'A bounded Project Notes request is required');
        },

        prepareProjectNotesWrite(input: NativeProjectNotesWriteRequest): NativeHostResult<NativeProjectNotesWritePreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Project Notes request is required');
            const state = useTaskStore.getState();
            const project = state._projectsById.get(request.projectId);
            if (!project || project.deletedAt || project.purgedAt || !same(token(project), request.expected))
                return fail('STALE_REVISION', 'Project changed; refresh before editing Notes');
            if (project.status === 'archived')
                return { ok: true, value: { kind: 'blocked', result: { blocked: '' } } };
            if (isProjectNotesWriteNoop(project, request.text))
                return { ok: true, value: { kind: 'noop', result: result(project) } };
            const device = ensureDeviceId(state.settings);
            const updateAt = new Date().toISOString();
            const prepared: NativePreparedProjectNotesWrite = { version: 1, request,
                scope: { project }, effect: projectNotesWriteEffect(project, request.text, device.deviceId, updateAt),
                deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                updateAt, result: { id: project.id, supportNotes: request.text } };
            const frozen = detach<NativePreparedProjectNotesWrite>(JSON.parse(JSON.stringify(prepared)));
            return frozen && readPrepared({ request, prepared: frozen })
                ? { ok: true, value: { kind: 'prepared', prepared: frozen } }
                : fail('INVALID_INPUT', 'Project Notes edit exceeds the bounded journal');
        },

        validatePreparedProjectNotesWrite(input: { request: NativeProjectNotesWriteRequest;
            prepared: NativePreparedProjectNotesWrite }): NativeHostResult<NativeProjectNotesWriteResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result }
                : fail('INVALID_INPUT', 'Prepared Project Notes request or journal does not match');
        },

        async commitPreparedProjectNotesWrite(input: { request: NativeProjectNotesWriteRequest;
            prepared: NativePreparedProjectNotesWrite }): Promise<NativeHostResult<NativeProjectNotesWriteResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared Project Notes request or journal does not match');
            const applied = await useTaskStore.getState().commitPreparedProjectNotesWrite(prepared);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared Project Notes edit conflicts with current data');
            try {
                if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            } catch (error) { return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error)); }
            const saved = await deps.save();
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
    };
}
