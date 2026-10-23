import type { NativeHostResult } from './native-host-contract';
import { taskEditValuesEqual } from './json-value-equality';
import { detach, exact, record, validProject } from './native-host-contract-project-shared';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { projectTagSuggestions, projectTagsForIntent, type ProjectTagsIntent } from './project-tags';
import { ensureDeviceId } from './store-helpers';
import { useTaskStore } from './store';
import { projectTagsWriteEffect, sameProjectSqliteRow } from './store-projects/project-actions';
import type { PreparedProjectTagsWrite } from './store-types';
import type { Project } from './types';

export type NativeProjectTagsWriteToken = { title: string; status: Project['status']; tagIds: string[];
    rev: number | null; revBy: string | null; updatedAt: string };
export type NativeProjectTagsWriteRequest = { requestId: string; projectId: string;
    intent: ProjectTagsIntent; expected: NativeProjectTagsWriteToken };
export type NativeProjectTagsWriteResult = { id: string; tagIds: string[] };
export type NativePreparedProjectTagsWrite = PreparedProjectTagsWrite & { version: 1;
    request: NativeProjectTagsWriteRequest; result: NativeProjectTagsWriteResult };
export type NativeProjectTagsWritePreparation = { kind: 'noop'; result: NativeProjectTagsWriteResult }
    | { kind: 'blocked'; result: { blocked: '' } }
    | { kind: 'prepared'; prepared: NativePreparedProjectTagsWrite };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const same = taskEditValuesEqual;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 500;
const iso = (value: unknown): value is string => typeof value === 'string' && value.length === 24
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const tags = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 100_000
    && value.every((tag) => typeof tag === 'string' && tag.length <= 100_000);
const token = (project: Project): NativeProjectTagsWriteToken => ({
    title: project.title, status: project.status, tagIds: project.tagIds ?? [],
    rev: project.rev ?? null, revBy: project.revBy ?? null, updatedAt: project.updatedAt,
});
const result = (project: Project): NativeProjectTagsWriteResult => ({ id: project.id, tagIds: project.tagIds ?? [] });
const validToken = (value: unknown): value is NativeProjectTagsWriteToken => record(value)
    && exact(value, ['title', 'status', 'tagIds', 'rev', 'revBy', 'updatedAt'])
    && typeof value.title === 'string' && value.title.length <= 100_000
    && ['active', 'someday', 'waiting', 'archived'].includes(String(value.status))
    && tags(value.tagIds)
    && (value.rev === null || typeof value.rev === 'number' && Number.isSafeInteger(value.rev) && value.rev >= 0)
    && (value.revBy === null || typeof value.revBy === 'string' && value.revBy.length <= 500)
    && iso(value.updatedAt);
const validIntent = (value: unknown): value is ProjectTagsIntent => record(value)
    && (value.kind === 'clear' && exact(value, ['kind'])
        || (value.kind === 'add' || value.kind === 'toggle') && exact(value, ['kind', 'input'])
            && typeof value.input === 'string' && value.input.length <= 100_000);
const readRequest = (value: unknown): NativeProjectTagsWriteRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    return input && exact(input, ['requestId', 'projectId', 'intent', 'expected'])
        && typeof input.requestId === 'string' && UUID.test(input.requestId)
        && id(input.projectId) && validIntent(input.intent) && validToken(input.expected)
        ? input as NativeProjectTagsWriteRequest : null;
};
const validTagProject = (value: unknown, projectId: string): value is Project => {
    if (!record(value)) return false;
    // SQLite may hydrate nullable optional columns as null. Preserve the raw frozen row.
    const normalized = { ...value, areaId: value.areaId ?? undefined, areaTitle: value.areaTitle ?? undefined,
        startDate: value.startDate ?? undefined, dueDate: value.dueDate ?? undefined,
        reviewAt: value.reviewAt ?? undefined, supportNotes: value.supportNotes ?? undefined,
        cancelledAt: value.cancelledAt ?? undefined, rev: value.rev ?? undefined,
        revBy: value.revBy ?? undefined, attachments: value.attachments ?? undefined,
        deletedAt: value.deletedAt ?? undefined, purgedAt: value.purgedAt ?? undefined };
    return validProject(normalized, projectId);
};

/** Pure cold-journal validation before consulting the mutable store or SQL. */
const readPrepared = (value: unknown): NativePreparedProjectTagsWrite | null => {
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
        || !iso(raw.updateAt) || !record(raw.result) || !exact(raw.result, ['id', 'tagIds'])
        || raw.result.id !== request.projectId || !tags(raw.result.tagIds)) return null;
    try {
        const prepared = raw as unknown as NativePreparedProjectTagsWrite;
        const before = prepared.scope.project;
        if (!validTagProject(before, request.projectId)
            || !validTagProject(prepared.effect.project.before, request.projectId)
            || !validTagProject(prepared.effect.project.after, request.projectId)
            || before.status === 'archived' || !same(token(before), request.expected)
            || !same(before, prepared.effect.project.before)) return null;
        const planned = projectTagsWriteEffect(before, request.intent,
            prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, prepared.updateAt);
        return planned && planned.project.after.rev! > (before.rev ?? 0)
            && same(planned, prepared.effect) && same(result(planned.project.after), prepared.result)
            && !sameProjectSqliteRow(before, planned.project.after) ? prepared : null;
    } catch { return null; }
};

export function createProjectTagsWriteMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    revision: () => string;
}) {
    return {
        getProjectTagsEditOptions(input: { projectId: string }): NativeHostResult<{ revision: string;
            project: { id: string } & NativeProjectTagsWriteToken; canEdit: boolean; suggestions: string[] }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!input || !id(input.projectId)) return fail('INVALID_INPUT', 'A Project ID is required');
            const state = useTaskStore.getState();
            const project = state._projectsById.get(input.projectId);
            if (!project || project.deletedAt || project.purgedAt)
                return fail('STALE_REVISION', 'Project is unavailable; refresh before editing Tags');
            const expected = token(project);
            if (!validToken(expected)) return fail('INVALID_INPUT', 'Project Tags token exceeds the bounded native response');
            const value = { revision: deps.revision(), project: { id: project.id, ...expected },
                canEdit: project.status !== 'archived',
                suggestions: projectTagSuggestions(state.tasks, state.projects, state.settings) };
            return value.suggestions.every((tag) => typeof tag === 'string' && tag.length <= 100_000)
                && isNativeJsonWithinBytes(value) ? { ok: true, value }
                : fail('INVALID_INPUT', 'Project Tags options exceed the bounded native response');
        },

        probeProjectTagsWriteOutcome(input: NativeProjectTagsWriteRequest): NativeHostResult<NativeProjectTagsWriteResult> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return readRequest(input) ? fail('STALE_REVISION', 'Project Tags outcome is unknown; refresh before trying again')
                : fail('INVALID_INPUT', 'A bounded Project Tags request is required');
        },

        prepareProjectTagsWrite(input: NativeProjectTagsWriteRequest): NativeHostResult<NativeProjectTagsWritePreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Project Tags request is required');
            const state = useTaskStore.getState();
            const project = state._projectsById.get(request.projectId);
            if (!project || project.deletedAt || project.purgedAt || !same(token(project), request.expected))
                return fail('STALE_REVISION', 'Project changed; refresh before editing Tags');
            if (project.status === 'archived')
                return { ok: true, value: { kind: 'blocked', result: { blocked: '' } } };
            const next = projectTagsForIntent(project.tagIds ?? [], request.intent);
            if (same(project.tagIds ?? [], next))
                return { ok: true, value: { kind: 'noop', result: result(project) } };
            const device = ensureDeviceId(state.settings);
            const updateAt = new Date().toISOString();
            const effect = projectTagsWriteEffect(project, request.intent, device.deviceId, updateAt);
            if (!effect || effect.project.after.rev! <= (project.rev ?? 0))
                return fail('STALE_REVISION', 'Project revision cannot advance');
            const prepared: NativePreparedProjectTagsWrite = { version: 1, request,
                scope: { project }, effect,
                deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                updateAt, result: result(effect.project.after) };
            const frozen = detach<NativePreparedProjectTagsWrite>(JSON.parse(JSON.stringify(prepared)));
            return frozen && readPrepared({ request, prepared: frozen })
                ? { ok: true, value: { kind: 'prepared', prepared: frozen } }
                : fail('INVALID_INPUT', 'Project Tags edit exceeds the bounded journal');
        },

        validatePreparedProjectTagsWrite(input: { request: NativeProjectTagsWriteRequest;
            prepared: NativePreparedProjectTagsWrite }): NativeHostResult<NativeProjectTagsWriteResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result }
                : fail('INVALID_INPUT', 'Prepared Project Tags request or journal does not match');
        },

        async commitPreparedProjectTagsWrite(input: { request: NativeProjectTagsWriteRequest;
            prepared: NativePreparedProjectTagsWrite }): Promise<NativeHostResult<NativeProjectTagsWriteResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared Project Tags request or journal does not match');
            const applied = await useTaskStore.getState().commitPreparedProjectTagsWrite(prepared);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared Project Tags edit conflicts with current data');
            try {
                if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            } catch (error) { return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error)); }
            const saved = await deps.save();
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
    };
}
