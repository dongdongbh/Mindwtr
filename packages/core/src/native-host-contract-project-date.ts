import type { NativeHostResult } from './native-host-contract';
import { safeFormatDate, safeParseDate } from './date';
import { taskEditValuesEqual } from './json-value-equality';
import { detach, exact, iso, record, validProject } from './native-host-contract-project-shared';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { ensureDeviceId } from './store-helpers';
import { useTaskStore } from './store';
import { isProjectDateNoop, projectDateEffect, sameProjectSqliteRow } from './store-projects/project-actions';
import type { PreparedProjectDate } from './store-types';
import type { Project } from './types';

export type NativeProjectDateField = 'startDate' | 'dueDate' | 'reviewAt';
export type NativeProjectDateToken = { title: string; status: Project['status'];
    startDate: string | null; dueDate: string | null; rev: number | null;
    revBy: string | null; updatedAt: string };
export type NativeProjectDateRequest = { requestId: string; projectId: string;
    field: NativeProjectDateField; value: string | null;
    expected: NativeProjectDateToken & { reviewAt?: string | null } };
export type NativeProjectDateResult = { id: string; field: NativeProjectDateField; value: string | null };
export type NativePreparedProjectDate = PreparedProjectDate & { version: 1;
    request: NativeProjectDateRequest; result: NativeProjectDateResult };
export type NativeProjectDatePreparation = { kind: 'noop'; result: NativeProjectDateResult }
    | { kind: 'blocked'; result: { blocked: '' } }
    | { kind: 'prepared'; prepared: NativePreparedProjectDate };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const same = taskEditValuesEqual;
const field = (value: unknown): value is NativeProjectDateField =>
    value === 'startDate' || value === 'dueDate' || value === 'reviewAt';
const rawDate = (value: unknown): value is string | null =>
    value === null || typeof value === 'string' && value.length <= 100;
const calendarDay = (value: unknown): value is string => {
    if (typeof value !== 'string' || !DAY.test(value)) return false;
    const parsed = safeParseDate(value);
    return parsed !== null && safeFormatDate(parsed, 'yyyy-MM-dd') === value;
};
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const token = (project: Project, selectedField: NativeProjectDateField): NativeProjectDateRequest['expected'] => ({
    title: project.title, status: project.status,
    startDate: project.startDate ?? null, dueDate: project.dueDate ?? null,
    rev: project.rev ?? null, revBy: project.revBy ?? null, updatedAt: project.updatedAt,
    ...(selectedField === 'reviewAt' ? { reviewAt: project.reviewAt ?? null } : {}),
});
const result = (request: NativeProjectDateRequest): NativeProjectDateResult =>
    ({ id: request.projectId, field: request.field, value: request.value });


const validDateProject = (value: unknown, projectId: string): value is Project => {
    if (!record(value) || !rawDate(value.startDate ?? null) || !rawDate(value.dueDate ?? null)) return false;
    return validProject({ ...value, startDate: value.startDate ?? undefined,
        dueDate: value.dueDate ?? undefined, reviewAt: value.reviewAt ?? undefined }, projectId);
};

const readRequest = (value: unknown): NativeProjectDateRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    if (!input || !exact(input, ['requestId', 'projectId', 'field', 'value', 'expected'])
        || typeof input.requestId !== 'string' || !UUID.test(input.requestId)
        || typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 500
        || !field(input.field) || !(input.value === null || (input.field === 'reviewAt'
            ? iso(input.value) : calendarDay(input.value)))
        || !record(input.expected)
        || !exact(input.expected, ['title', 'status', 'startDate', 'dueDate', 'rev', 'revBy', 'updatedAt',
            ...(input.field === 'reviewAt' ? ['reviewAt'] : [])])) return null;
    const expected = input.expected;
    return typeof expected.title === 'string' && expected.title.length <= 100_000
        && ['active', 'someday', 'waiting', 'archived'].includes(String(expected.status))
        && rawDate(expected.startDate) && rawDate(expected.dueDate)
        && (input.field !== 'reviewAt' || rawDate(expected.reviewAt))
        && (expected.rev === null || typeof expected.rev === 'number'
            && Number.isSafeInteger(expected.rev) && expected.rev >= 0)
        && (expected.revBy === null || typeof expected.revBy === 'string' && expected.revBy.length <= 500)
        && iso(expected.updatedAt) ? input as NativeProjectDateRequest : null;
};


const readPrepared = (value: unknown): NativePreparedProjectDate | null => {
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
        || !iso(raw.updateAt) || !record(raw.result) || !exact(raw.result, ['id', 'field', 'value'])
        || !same(raw.result, result(request))) return null;
    try {
        const prepared = raw as unknown as NativePreparedProjectDate;
        const before = prepared.scope.project;
        if (!validDateProject(before, request.projectId)
            || !validDateProject(prepared.effect.project.before, request.projectId)
            || !validDateProject(prepared.effect.project.after, request.projectId)
            || before.status === 'archived' || isProjectDateNoop(before, request.field, request.value)
            || !same(token(before, request.field), request.expected)
            || !same(before, prepared.effect.project.before)) return null;
        const planned = projectDateEffect(before, request.field, request.value,
            prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, prepared.updateAt);
        return same(planned, prepared.effect) && !sameProjectSqliteRow(before, planned.project.after)
            ? prepared : null;
    } catch { return null; }
};

export function createProjectDateMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    revision: () => string;
}) {
    return {
        getProjectDateOptions(input: { projectId: string; field: NativeProjectDateField }): NativeHostResult<{
            revision: string; project: { id: string } & NativeProjectDateRequest['expected'];
            canEdit: boolean; picker: { date: string; time: '12:00'; instant?: string;
                preserveUnchanged?: boolean } }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!input || typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 500
                || !field(input.field)) return fail('INVALID_INPUT', 'A Project ID and date field are required');
            const project = useTaskStore.getState()._projectsById.get(input.projectId);
            if (!project || project.deletedAt || project.purgedAt)
                return fail('STALE_REVISION', 'Project is unavailable; refresh before changing its date');
            const expected = token(project, input.field);
            if (!rawDate(expected.startDate) || !rawDate(expected.dueDate)
                || (input.field === 'reviewAt' && !rawDate(expected.reviewAt)))
                return fail('INVALID_INPUT', 'Project date token exceeds the bounded native response');
            const selected = project[input.field];
            const parsed = safeParseDate(selected);
            const selectedDate = parsed ?? new Date();
            const picker = { date: safeFormatDate(selectedDate, 'yyyy-MM-dd'), time: '12:00' as const,
                ...(input.field === 'reviewAt'
                    ? { instant: selectedDate.toISOString(), preserveUnchanged: parsed !== null } : {}) };
            const value = { revision: deps.revision(), project: { id: project.id, ...expected },
                canEdit: project.status !== 'archived', picker };
            return isNativeJsonWithinBytes(value) ? { ok: true, value }
                : fail('INVALID_INPUT', 'Project date options exceed the bounded native response');
        },

        probeProjectDateOutcome(input: NativeProjectDateRequest): NativeHostResult<NativeProjectDateResult> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return readRequest(input) ? fail('STALE_REVISION', 'Project date outcome is unknown; refresh before trying again')
                : fail('INVALID_INPUT', 'A bounded Project date request is required');
        },

        prepareProjectDate(input: NativeProjectDateRequest): NativeHostResult<NativeProjectDatePreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Project date request is required');
            const state = useTaskStore.getState();
            const project = state._projectsById.get(request.projectId);
            if (!project || project.deletedAt || project.purgedAt
                || !same(token(project, request.field), request.expected))
                return fail('STALE_REVISION', 'Project changed; refresh before changing its date');
            if (project.status === 'archived')
                return { ok: true, value: { kind: 'blocked', result: { blocked: '' } } };
            if (isProjectDateNoop(project, request.field, request.value))
                return { ok: true, value: { kind: 'noop', result: result(request) } };
            const device = ensureDeviceId(state.settings);
            const updateAt = new Date().toISOString();
            const effect = projectDateEffect(project, request.field, request.value, device.deviceId, updateAt);
            const prepared: NativePreparedProjectDate = { version: 1, request,
                scope: { project }, effect,
                deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                updateAt, result: result(request) };
            const frozen = detach<NativePreparedProjectDate>(JSON.parse(JSON.stringify(prepared)));
            return frozen && readPrepared({ request, prepared: frozen })
                ? { ok: true, value: { kind: 'prepared', prepared: frozen } }
                : fail('INVALID_INPUT', 'Project date edit exceeds the bounded journal');
        },

        validatePreparedProjectDate(input: { request: NativeProjectDateRequest;
            prepared: NativePreparedProjectDate }): NativeHostResult<NativeProjectDateResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result }
                : fail('INVALID_INPUT', 'Prepared Project date request or journal does not match');
        },

        async commitPreparedProjectDate(input: { request: NativeProjectDateRequest;
            prepared: NativePreparedProjectDate }): Promise<NativeHostResult<NativeProjectDateResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared Project date request or journal does not match');
            const applied = await useTaskStore.getState().commitPreparedProjectDate(prepared);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'Prepared Project date conflicts with current data');
            try {
                if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
            } catch (error) { return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error)); }
            const saved = await deps.save();
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
    };
}
