import type { NativeHostResult } from './native-host-contract';
import { taskEditValuesEqual } from './json-value-equality';
import { detach, exact, iso, record, validProject } from './native-host-contract-project-shared';
import { validSection } from './native-host-contract-project-section-rename';
import { validRawTask } from './native-host-contract-task-save';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { createNativeRequestReceipts, revisionOf, revisionsToken } from './native-request-receipts';
import { ensureDeviceId } from './store-helpers';
import { logInfo } from './logger';
import { useTaskStore } from './store';
import { isTaskFinished } from './task-status';
import { projectLifecycleEffect } from './store-projects/project-actions';
import type { PreparedProjectLifecycle } from './store-types';
import type { Project, Task } from './types';

export type NativeProjectLifecycleRequest = PreparedProjectLifecycle['request'];
export type NativeProjectLifecycleResult = PreparedProjectLifecycle['result'];
export type NativePreparedProjectLifecycle = PreparedProjectLifecycle;
export type NativeProjectLifecycleEnvelope = { request: NativeProjectLifecycleRequest;
    prepared: NativePreparedProjectLifecycle };
export type NativeProjectLifecyclePreparation = { kind: 'prepared'; prepared: NativePreparedProjectLifecycle };

export type NativeReviewProjectCompletionOptions = { projectId: string; title: string; projectRevision: string;
    scopeRevision: string; requiresConfirmation: boolean };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const same = taskEditValuesEqual;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
const unique = (rows: { id: string }[]) => new Set(rows.map((row) => row.id)).size === rows.length;
const jsonSafe = <T,>(value: unknown): T | null => {
    try { return detach<T>(JSON.parse(JSON.stringify(value))); } catch { return null; }
};
const canonicalPayload = (value: unknown): string => JSON.stringify(value, (_key, item) => record(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
    : item);
const payload = (envelope: NativeProjectLifecycleEnvelope): string =>
    canonicalPayload(['preparedProjectLifecycle', envelope]);

const readRequest = (value: unknown): NativeProjectLifecycleRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    return input && isNativeJsonWithinBytes(input, 4_096)
        && exact(input, ['requestId', 'projectId', 'projectRevision', 'action'])
        && typeof input.requestId === 'string' && UUID.test(input.requestId)
        && text(input.projectId) && text(input.projectRevision)
        && (input.action === 'complete' || input.action === 'cancel' || input.action === 'reactivate')
        ? input as NativeProjectLifecycleRequest : null;
};
const validProjectRow = (value: unknown, id: string): value is Project => validProject(value, id)
    && (value.archivedAt === undefined || iso(value.archivedAt))
    && (value.cancelledAt === undefined || iso(value.cancelledAt));
const validTask = (value: unknown): value is Task => record(value) && typeof value.id === 'string'
    && validRawTask(value, value.id)
    && (value.deletedAt === undefined || iso(value.deletedAt))
    && (value.purgedAt === undefined || iso(value.purgedAt));
const validDevice = (raw: Record<string, unknown>) =>
    (raw.deviceIdBefore === null || typeof raw.deviceIdBefore === 'string' && Boolean(raw.deviceIdBefore))
    && (raw.deviceIdBefore === null
        ? typeof raw.deviceIdToInitialize === 'string' && UUID.test(raw.deviceIdToInitialize)
        : raw.deviceIdToInitialize === null)
    && iso(raw.updateAt);

const readEnvelope = (input: unknown): NativeProjectLifecycleEnvelope | null => {
    const envelope = detach<Record<string, unknown>>(input);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'scope', 'effect', 'deviceIdBefore',
        'deviceIdToInitialize', 'updateAt', 'result']) || raw.version !== 1 || !same(raw.request, request)
        || !record(raw.scope) || !exact(raw.scope, ['project', 'tasks', 'sections'])
        || !Array.isArray(raw.scope.tasks) || !Array.isArray(raw.scope.sections)
        || !record(raw.effect) || !exact(raw.effect, ['project', 'tasks', 'sections'])
        || !record(raw.effect.project) || !exact(raw.effect.project, ['before', 'after'])
        || !Array.isArray(raw.effect.tasks) || !Array.isArray(raw.effect.sections)
        || !validDevice(raw) || !record(raw.result) || !exact(raw.result, ['id', 'status'])
        || raw.result.id !== request.projectId
        || raw.result.status !== (request.action === 'reactivate' ? 'active' : 'archived')) return null;
    try {
        const prepared = raw as unknown as NativePreparedProjectLifecycle;
        const { scope, effect } = prepared;
        if (!validProjectRow(scope.project, request.projectId)
            || scope.project.purgedAt || revisionOf(scope.project) !== request.projectRevision
            || request.action !== 'reactivate' && scope.project.status === 'archived'
            || request.action === 'reactivate' && scope.project.status !== 'archived'
            || !unique(scope.tasks) || !unique(scope.sections)
            || scope.sections.some((row) => !validSection(row, row.id, request.projectId))
            || scope.tasks.some((row) => !validTask(row))
            || !validProjectRow(effect.project.before, request.projectId)
            || !validProjectRow(effect.project.after, request.projectId)
            || !same(scope.project, effect.project.before)) return null;
        const sectionIds = new Set(scope.sections.map((row) => row.id));
        if (scope.tasks.some((row) => row.projectId !== request.projectId
            && (row.projectId !== undefined || row.sectionId === undefined || !sectionIds.has(row.sectionId)))
            || effect.tasks.some((pair) => !record(pair) || !exact(pair, ['before', 'after'])
                || !validTask(pair.before) || !validTask(pair.after))
            || effect.sections.some((pair) => !record(pair) || !exact(pair, ['before', 'after'])
                || !validSection(pair.before, pair.before.id, request.projectId)
                || !validSection(pair.after, pair.before.id, request.projectId))) return null;
        return same(projectLifecycleEffect(scope, request.action,
            prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, prepared.updateAt), effect)
            ? envelope as NativeProjectLifecycleEnvelope : null;
    } catch { return null; }
};

const projectScope = (project: Project): PreparedProjectLifecycle['scope'] => {
    const state = useTaskStore.getState();
    const sections = state._allSections.filter((row) => row.projectId === project.id);
    const sectionIds = new Set(sections.map((row) => row.id));
    return { project, sections, tasks: state._allTasks.filter((row) => row.projectId === project.id
        || (!row.projectId && row.sectionId !== undefined && sectionIds.has(row.sectionId))) };
};
const scopeRevision = (scope: PreparedProjectLifecycle['scope']): string => revisionsToken([
    JSON.stringify(['project', scope.project.id, revisionOf(scope.project)]),
    ...scope.sections.map((row) => JSON.stringify(['section', row.id, revisionOf(row)])),
    ...scope.tasks.map((row) => JSON.stringify(['task', row.id, revisionOf(row)])),
].sort());

export function createProjectLifecycleMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
}) {
    const receipts = createNativeRequestReceipts({ save: async () => {
        if (useTaskStore.getState().persistenceFailure) {
            try { await useTaskStore.getState().retryPersistence(); }
            catch (error) { return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error)); }
        }
        return deps.save();
    } });
    const methods = {
        getReviewProjectCompletionOptions(input: { projectId: string }): NativeHostResult<NativeReviewProjectCompletionOptions> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!record(input) || !exact(input, ['projectId']) || !text(input.projectId))
                return fail('INVALID_INPUT', 'A bounded Review Project identifier is required');
            const project = useTaskStore.getState()._projectsById.get(input.projectId);
            if (!project || project.deletedAt || project.purgedAt || project.status !== 'active')
                return fail('STALE_REVISION', 'Project changed since the review was read');
            const scope = projectScope(project);
            return { ok: true, value: { projectId: project.id, title: project.title, projectRevision: revisionOf(project),
                scopeRevision: scopeRevision(scope), requiresConfirmation: scope.tasks.some((task) => !task.deletedAt
                    && !isTaskFinished(task) && task.status !== 'reference') } };
        },
        prepareReviewProjectCompletion(input: { request: NativeProjectLifecycleRequest; scopeRevision: string }): NativeHostResult<NativeProjectLifecyclePreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!record(input) || !exact(input, ['request', 'scopeRevision']) || !text(input.scopeRevision))
                return fail('INVALID_INPUT', 'A bounded Review Project completion scope is required');
            const request = readRequest(input.request);
            if (!request || request.action !== 'complete')
                return fail('INVALID_INPUT', 'Review can only complete an active Project');
            const options = methods.getReviewProjectCompletionOptions({ projectId: request.projectId });
            if (!options.ok) return options;
            if (options.value.projectRevision !== request.projectRevision || options.value.scopeRevision !== input.scopeRevision)
                return fail('STALE_REVISION', 'Project or its tasks changed since completion was offered');
            return methods.prepareProjectLifecycle(request);
        },
        prepareProjectLifecycle(input: NativeProjectLifecycleRequest): NativeHostResult<NativeProjectLifecyclePreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Project lifecycle request is required');
            const state = useTaskStore.getState();
            const target = state._projectsById.get(request.projectId);
            if (!target || target.deletedAt || target.purgedAt
                || revisionOf(target) !== request.projectRevision
                || request.action !== 'reactivate' && target.status === 'archived'
                || request.action === 'reactivate' && target.status !== 'archived')
                return fail('STALE_REVISION', 'Project changed since the detail was read');
            const scope = projectScope(target);
            const device = ensureDeviceId(state.settings);
            const updateAt = new Date().toISOString();
            const effect = projectLifecycleEffect(scope, request.action, device.deviceId, updateAt);
            const prepared = jsonSafe<PreparedProjectLifecycle>({ version: 1, request, scope, effect,
                deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                updateAt, result: { id: target.id, status: request.action === 'reactivate' ? 'active' : 'archived' } });
            return prepared && readEnvelope({ request, prepared })
                ? { ok: true, value: { kind: 'prepared', prepared } }
                : fail('INVALID_INPUT', 'Project lifecycle exceeds the bounded native journal');
        },
        validatePreparedProjectLifecycle(input: NativeProjectLifecycleEnvelope): NativeHostResult<NativeProjectLifecycleResult> {
            const envelope = readEnvelope(input);
            return envelope ? { ok: true, value: envelope.prepared.result }
                : fail('INVALID_INPUT', 'Prepared Project lifecycle is malformed');
        },
        projectLifecycleOutcome(input: NativeProjectLifecycleEnvelope): NativeHostResult<NativeProjectLifecycleResult | null> {
            const envelope = readEnvelope(input);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared Project lifecycle is malformed');
            const saved = receipts.saved<NativeProjectLifecycleResult>(envelope.request.requestId, payload(envelope));
            if (saved?.ok && !same(saved.value, envelope.prepared.result))
                return fail('INVALID_INPUT', 'Saved Project lifecycle result does not match the prepared request');
            return saved === null ? { ok: true, value: null } : saved;
        },
        async commitPreparedProjectLifecycle(input: NativeProjectLifecycleEnvelope): Promise<NativeHostResult<NativeProjectLifecycleResult>> {
            const envelope = readEnvelope(input);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared Project lifecycle is malformed');
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const confirmed = await receipts.run(envelope.request.requestId, payload(envelope), async () => {
                const applied = await useTaskStore.getState().commitPreparedProjectLifecycle(envelope.prepared);
                return applied.success ? { ok: true, value: envelope.prepared.result }
                    : fail('STALE_REVISION', applied.error ?? 'Prepared Project lifecycle conflicts with saved data');
            });
            if (confirmed.ok && envelope.request.action === 'reactivate') {
                try { logInfo('Native archived Project restore confirmed', { scope: 'native-host', category: 'storage',
                    context: { releaseCheck: 'v1.3.4/ios-archive-project-restore', outcome: 'confirmed' } }); }
                catch { /* Diagnostics cannot invalidate a durable acknowledgment. */ }
            }
            return confirmed;
        },
    };
    return methods;
}
