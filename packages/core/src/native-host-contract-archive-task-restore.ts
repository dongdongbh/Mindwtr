import type { NativeHostResult } from './native-host-contract';
import { taskEditValuesEqual } from './json-value-equality';
import { detach, exact, iso, record, validProject } from './native-host-contract-project-shared';
import { validSection } from './native-host-contract-project-section-rename';
import { validRawTask } from './native-host-contract-task-save';
import { validFrozenFocusDate } from './native-host-contract-task-focus';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { readAreaDurableData } from './native-host-contract-area-durable';
import { createNativeRequestReceipts, taskRevisionOf } from './native-request-receipts';
import { ensureDeviceId } from './store-helpers';
import { archiveRestoreEffect, archiveRestoreScope } from './store-tasks';
export { archiveRestoreEffect, archiveRestoreScope } from './store-tasks';
import { useTaskStore } from './store';
import { projectFocusDateValues, type FocusDateProjection } from './task-utils';
import { logInfo } from './logger';
import type { Area, Project, Section, Task } from './types';

export type NativeArchivedTaskRestoreRequest = { requestId: string; taskId: string; taskRevision: string };
export type NativeArchivedTaskRestoreResult = { id: string; status: 'inbox' };
export type NativePreparedArchivedTaskRestore = {
    version: 1;
    request: NativeArchivedTaskRestoreRequest;
    scope: { task: Task; parentProject: Project | null; parentTasks: Task[];
        parentSections: Section[]; sourceArea: Area | null; fullParent: boolean };
    effect: { tasks: { before: Task; after: Task }[];
        project: { before: Project; after: Project } | null;
        sections: { before: Section; after: Section }[] };
    deviceIdBefore: string | null;
    deviceIdToInitialize: string | null;
    updateAt: string;
    preparedLocalDay: string;
    preparedOffsetMinutes: number;
    boundaryOffsetMinutes: number;
    futureBoundary: string;
    dates: FocusDateProjection[];
    result: NativeArchivedTaskRestoreResult;
};
export type NativeArchivedTaskRestoreEnvelope = { request: NativeArchivedTaskRestoreRequest;
    prepared: NativePreparedArchivedTaskRestore };
export type NativeArchivedTaskRestorePreparation = { kind: 'prepared'; prepared: NativePreparedArchivedTaskRestore };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const same = taskEditValuesEqual;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'TASK_NOT_FOUND' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const unique = (rows: { id: string }[]) => new Set(rows.map((row) => row.id)).size === rows.length;
const text = (value: unknown, limit: number): value is string =>
    typeof value === 'string' && Boolean(value.trim()) && value.length <= limit;
const canonicalPayload = (value: unknown): string => JSON.stringify(value, (_key, item) => record(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
    : item);
const jsonSafe = <T,>(value: unknown): T | null => {
    try { return detach<T>(JSON.parse(JSON.stringify(value))); } catch { return null; }
};

const readRequest = (value: unknown): NativeArchivedTaskRestoreRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    return input && isNativeJsonWithinBytes(input, 4_096)
        && exact(input, ['requestId', 'taskId', 'taskRevision'])
        && typeof input.requestId === 'string' && UUID.test(input.requestId)
        && text(input.taskId, 500) && text(input.taskRevision, 200)
        ? input as NativeArchivedTaskRestoreRequest : null;
};
const validTask = (value: unknown): value is Task => record(value) && text(value.id, 500)
    && validRawTask(value, value.id)
    && (value.archivedAt === undefined || iso(value.archivedAt))
    && (value.completedAt === undefined || iso(value.completedAt))
    && (value.cancelledAt === undefined || iso(value.cancelledAt))
    && (value.deletedAt === undefined || iso(value.deletedAt))
    && (value.purgedAt === undefined || iso(value.purgedAt));
const validArea = (value: unknown): value is Area => record(value) && text(value.id, 500)
    && typeof value.name === 'string' && iso(value.createdAt) && iso(value.updatedAt)
    && (value.deletedAt === undefined || iso(value.deletedAt));
const validDevice = (raw: Record<string, unknown>) =>
    (raw.deviceIdBefore === null || text(raw.deviceIdBefore, 500))
    && (raw.deviceIdBefore === null
        ? typeof raw.deviceIdToInitialize === 'string' && UUID.test(raw.deviceIdToInitialize)
        : raw.deviceIdToInitialize === null)
    && iso(raw.updateAt);

const requiredDates = (task: Task): string[] => [...new Set([task.startTime, task.dueDate, task.reviewAt]
    .filter((value): value is string => typeof value === 'string'))].sort();

const readEnvelope = (input: unknown): NativeArchivedTaskRestoreEnvelope | null => {
    const envelope = detach<Record<string, unknown>>(input);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'scope', 'effect', 'deviceIdBefore',
        'deviceIdToInitialize', 'updateAt', 'preparedLocalDay', 'preparedOffsetMinutes',
        'boundaryOffsetMinutes', 'futureBoundary', 'dates', 'result'])
        || raw.version !== 1 || !same(raw.request, request)
        || !record(raw.scope) || !exact(raw.scope, ['task', 'parentProject', 'parentTasks',
            'parentSections', 'sourceArea', 'fullParent'])
        || !record(raw.effect) || !exact(raw.effect, ['tasks', 'project', 'sections'])
        || !Array.isArray(raw.scope.parentTasks) || !Array.isArray(raw.scope.parentSections)
        || !Array.isArray(raw.effect.tasks) || !Array.isArray(raw.effect.sections)
        || !validDevice(raw) || typeof raw.preparedLocalDay !== 'string'
        || !/^\d{4}-\d{2}-\d{2}$/.test(raw.preparedLocalDay)
        || !Number.isInteger(raw.preparedOffsetMinutes) || Math.abs(raw.preparedOffsetMinutes as number) > 840
        || !Number.isInteger(raw.boundaryOffsetMinutes) || Math.abs(raw.boundaryOffsetMinutes as number) > 840
        || !iso(raw.futureBoundary) || !Array.isArray(raw.dates)
        || !record(raw.result) || !exact(raw.result, ['id', 'status'])
        || raw.result.id !== request.taskId || raw.result.status !== 'inbox') return null;
    try {
        const prepared = raw as unknown as NativePreparedArchivedTaskRestore;
        const { scope, effect } = prepared;
        if (!validTask(scope.task) || scope.task.id !== request.taskId
            || scope.task.status !== 'archived' || scope.task.deletedAt || scope.task.purgedAt
            || taskRevisionOf(scope.task) !== request.taskRevision
            || typeof scope.fullParent !== 'boolean'
            || !scope.parentTasks.every(validTask) || !scope.parentSections.every((row) =>
                record(row) && typeof row.id === 'string' && validSection(row, row.id, row.projectId))
            || !unique(scope.parentTasks) || !unique(scope.parentSections)
            || !scope.parentTasks.some((row) => row.id === scope.task.id && same(row, scope.task))
            || (scope.parentProject !== null && (!validProject(scope.parentProject, scope.parentProject.id)
                || scope.parentProject.purgedAt || scope.parentProject.deletedAt
                || scope.parentProject.archivedAt !== undefined && !iso(scope.parentProject.archivedAt)
                || scope.parentProject.cancelledAt !== undefined && !iso(scope.parentProject.cancelledAt)))
            || (scope.sourceArea !== null && (!validArea(scope.sourceArea) || scope.sourceArea.deletedAt))
            || (scope.parentProject?.id ?? null) !== (scope.task.projectId ??
                scope.parentSections.find((row) => row.id === scope.task.sectionId)?.projectId ?? null)
            || (scope.parentProject ? scope.sourceArea !== null
                : (scope.sourceArea?.id ?? null) !== (scope.task.areaId ?? null))
            || scope.fullParent !== Boolean(scope.parentProject?.status === 'archived'
                && (scope.task.projectId === scope.parentProject.id
                    || scope.parentSections.find((row) => row.id === scope.task.sectionId)?.projectId === scope.parentProject.id))) return null;
        if (scope.fullParent && scope.parentProject) {
            const sectionIds = new Set(scope.parentSections.map((row) => row.id));
            if (scope.parentSections.some((row) => row.projectId !== scope.parentProject?.id)
                || scope.parentTasks.some((row) => row.projectId !== scope.parentProject?.id
                    && (row.projectId !== undefined || row.sectionId === undefined || !sectionIds.has(row.sectionId)))) return null;
        } else if (scope.parentTasks.length !== 1 || scope.parentSections.some((row) => row.id !== scope.task.sectionId)) return null;
        if (new Date(Date.parse(prepared.updateAt) - prepared.preparedOffsetMinutes * 60_000)
            .toISOString().slice(0, 10) !== prepared.preparedLocalDay
            || new Date(Date.parse(`${prepared.preparedLocalDay}T23:59:59.999Z`)
                + prepared.boundaryOffsetMinutes * 60_000).toISOString() !== prepared.futureBoundary
            || !same(requiredDates(scope.task), prepared.dates.map((row) => row.value))
            || prepared.dates.some((row) => !validFrozenFocusDate(row))) return null;
        const dates = new Map(prepared.dates.map((row) => [row.value, row]));
        const expected = archiveRestoreEffect(scope,
            prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, prepared.updateAt,
            prepared.futureBoundary, dates);
        if (!expected || !expected.tasks.some((pair) => pair.before.id === request.taskId)
            || !same(expected, effect)
            || effect.tasks.some((pair) => !record(pair) || !exact(pair, ['before', 'after'])
                || !validTask(pair.before) || !validTask(pair.after))
            || effect.sections.some((pair) => !record(pair) || !exact(pair, ['before', 'after'])
                || !record(pair.before) || !record(pair.after))) return null;
        return envelope as NativeArchivedTaskRestoreEnvelope;
    } catch { return null; }
};

export function createArchivedTaskRestoreMethods(deps: {
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
    const payload = (envelope: NativeArchivedTaskRestoreEnvelope) =>
        canonicalPayload(['archivedTaskRestore', envelope]);
    return {
        async prepareArchivedTaskRestore(input: NativeArchivedTaskRestoreRequest): Promise<NativeHostResult<NativeArchivedTaskRestorePreparation>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded archived Task restore request is required');
            const read = await readAreaDurableData(false, true);
            if (!read.ok) return read;
            const data = read.value.authority.snapshot;
            const matches = data.tasks.filter((row) => row.id === request.taskId);
            const task = matches.length === 1 ? matches[0] : null;
            if (!task || task.deletedAt || task.purgedAt) return fail('TASK_NOT_FOUND', 'Task not found');
            if (taskRevisionOf(task) !== request.taskRevision) return fail('STALE_REVISION', 'Task changed since History was shown');
            if (task.status !== 'archived') return fail('INVALID_INPUT', 'Task is not archived');
            const scope = archiveRestoreScope(task, data);
            const device = ensureDeviceId(data.settings);
            const now = new Date();
            const updateAt = now.toISOString();
            const end = new Date(now); end.setHours(23, 59, 59, 999);
            const futureBoundary = end.toISOString();
            const dates = projectFocusDateValues(requiredDates(task));
            const effect = archiveRestoreEffect(scope, device.deviceId, updateAt, futureBoundary,
                new Map(dates.map((row) => [row.value, row])));
            const prepared = effect && jsonSafe<NativePreparedArchivedTaskRestore>({ version: 1, request, scope, effect,
                deviceIdBefore: data.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                updateAt, preparedLocalDay: new Date(Date.parse(updateAt) - now.getTimezoneOffset() * 60_000)
                    .toISOString().slice(0, 10), preparedOffsetMinutes: now.getTimezoneOffset(),
                boundaryOffsetMinutes: end.getTimezoneOffset(), futureBoundary, dates,
                result: { id: task.id, status: 'inbox' } });
            return prepared && readEnvelope({ request, prepared })
                ? { ok: true, value: { kind: 'prepared', prepared } }
                : fail('INVALID_INPUT', 'Archived Task restore cannot produce a bounded prepared journal');
        },
        validatePreparedArchivedTaskRestore(input: NativeArchivedTaskRestoreEnvelope): NativeHostResult<NativeArchivedTaskRestoreResult> {
            const envelope = readEnvelope(input);
            return envelope ? { ok: true, value: envelope.prepared.result }
                : fail('INVALID_INPUT', 'Prepared archived Task restore is malformed');
        },
        archivedTaskRestoreOutcome(input: NativeArchivedTaskRestoreEnvelope): NativeHostResult<NativeArchivedTaskRestoreResult | null> {
            const envelope = readEnvelope(input);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared archived Task restore is malformed');
            const saved = receipts.saved<NativeArchivedTaskRestoreResult>(envelope.request.requestId, payload(envelope));
            return saved === null ? { ok: true, value: null } : saved;
        },
        async commitPreparedArchivedTaskRestore(input: NativeArchivedTaskRestoreEnvelope): Promise<NativeHostResult<NativeArchivedTaskRestoreResult>> {
            const envelope = readEnvelope(input);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared archived Task restore is malformed');
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const confirmed = await receipts.run(envelope.request.requestId, payload(envelope), async () => {
                const read = await readAreaDurableData(false, true);
                if (!read.ok) return read;
                const applied = await useTaskStore.getState().commitPreparedArchivedTaskRestore(envelope.prepared, read.value.authority);
                return applied.success ? { ok: true, value: envelope.prepared.result }
                    : fail('STALE_REVISION', applied.error ?? 'Archived Task restore conflicts with saved data');
            });
            if (confirmed.ok) {
                try { logInfo('Native archived Task restore confirmed', { scope: 'native-host', category: 'storage',
                    context: { releaseCheck: 'v1.3.4/ios-archive-task-restore', outcome: 'confirmed' } }); }
                catch {                                                               }
            }
            return confirmed;
        },
    };
}
