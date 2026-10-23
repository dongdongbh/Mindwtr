import type { NativeHostResult } from './native-host-contract';
import { AREA_SYNC_FIELD_SCHEMA, areaToSqliteRow } from './area-sync-schema';
import { detach, exact, iso, record, validProject } from './native-host-contract-project-shared';
import { validSection } from './native-host-contract-project-section-rename';
import { validRawTask } from './native-host-contract-task-save';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { createNativeRequestReceipts, revisionOf } from './native-request-receipts';
import { taskEditValuesEqual } from './json-value-equality';
import { ensureDeviceId } from './store-helpers';
import { useTaskStore } from './store';
import { projectRestoreEffect } from './store-projects/project-actions';
import type { PreparedTrashProjectRestore } from './store-types';
import type { Area, Project } from './types';

export type NativeTrashProjectRestoreRequest = PreparedTrashProjectRestore['request'];
export type NativePreparedTrashProjectRestore = PreparedTrashProjectRestore & { version: 1 | 2 };
export type NativeTrashProjectRestorePreparation = { kind: 'prepared'; prepared: NativePreparedTrashProjectRestore };
export type NativeTrashProjectRestoreEnvelope = { request: NativeTrashProjectRestoreRequest;
    prepared: NativePreparedTrashProjectRestore };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const areaKeys = new Set(AREA_SYNC_FIELD_SCHEMA.map((field) => field.name));
const same = taskEditValuesEqual;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
const canonicalPayload = (value: unknown): string => JSON.stringify(value, (_key, item) => record(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
    : item);

const readRequest = (value: unknown): NativeTrashProjectRestoreRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    return input && isNativeJsonWithinBytes(input, 4_096) && exact(input, ['requestId', 'projectId', 'projectRevision'])
        && typeof input.requestId === 'string' && UUID.test(input.requestId)
        && text(input.projectId) && text(input.projectRevision)
        ? input as NativeTrashProjectRestoreRequest : null;
};

const validRawProject = (value: unknown, id: string): value is Project => record(value)
    && iso(value.deletedAt) && value.purgedAt === undefined
    && (value.archivedAt === undefined || iso(value.archivedAt))
    && (value.cancelledAt === undefined || iso(value.cancelledAt))
    && validProject({ ...value, deletedAt: undefined }, id);

const validRawArea = (value: unknown, id: string): value is Area => {
    if (!record(value) || value.id !== id || Object.keys(value).some((key) => !areaKeys.has(key as keyof Area))
        || typeof value.name !== 'string' || typeof value.order !== 'number' || !Number.isFinite(value.order)
        || (value.color !== undefined && typeof value.color !== 'string')
        || (value.icon !== undefined && typeof value.icon !== 'string')
        || (value.rev !== undefined && !(typeof value.rev === 'number'
            && Number.isSafeInteger(value.rev) && value.rev >= 0))
        || (value.revBy !== undefined && typeof value.revBy !== 'string')
        || !iso(value.createdAt) || !iso(value.updatedAt)
        || (value.deletedAt !== undefined && !iso(value.deletedAt))) return false;
    try { areaToSqliteRow(value as unknown as Area, value.updatedAt as string); return true; }
    catch { return false; }
};

const unique = (rows: { id: string }[]) => new Set(rows.map((row) => row.id)).size === rows.length;

/** Pure validation of the frozen effect before Swift opens SQLite for replay. */
const readPrepared = (input: unknown): NativeTrashProjectRestoreEnvelope | null => {
    const envelope = detach<Record<string, unknown>>(input);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'scope', 'effect', 'deviceIdBefore',
        'deviceIdToInitialize', 'updateAt', 'result']) || (raw.version !== 1 && raw.version !== 2)
        || !same(raw.request, request) || !record(raw.scope)
        || !exact(raw.scope, ['project', 'tasks', 'sections', 'area'])
        || !Array.isArray(raw.scope.tasks) || !Array.isArray(raw.scope.sections)
        || !record(raw.effect) || !exact(raw.effect, ['project', 'tasks', 'sections'])
        || !record(raw.effect.project) || !exact(raw.effect.project, ['before', 'after'])
        || !Array.isArray(raw.effect.tasks) || !Array.isArray(raw.effect.sections)
        || !(raw.deviceIdBefore === null || typeof raw.deviceIdBefore === 'string' && Boolean(raw.deviceIdBefore))
        || (raw.deviceIdBefore === null
            ? typeof raw.deviceIdToInitialize !== 'string' || !UUID.test(raw.deviceIdToInitialize)
            : raw.deviceIdToInitialize !== null)
        || !iso(raw.updateAt) || !record(raw.result) || !exact(raw.result, ['id'])
        || raw.result.id !== request.projectId) return null;
    try {
        const prepared = raw as unknown as NativePreparedTrashProjectRestore;
        const { scope, effect } = prepared;
        if (!validRawProject(scope.project, request.projectId)
            || revisionOf(scope.project) !== request.projectRevision
            || !Array.isArray(scope.tasks) || !unique(scope.tasks)
            || scope.tasks.some((task) => !validRawTask(task, task.id) || task.projectId !== request.projectId
                || task.deletedAt !== undefined && !iso(task.deletedAt)
                || task.purgedAt !== undefined && !iso(task.purgedAt))
            || !Array.isArray(scope.sections) || !unique(scope.sections)
            || scope.sections.some((section) => !validSection(section, section.id, request.projectId))
            || scope.area !== null && (!scope.project.areaId
                || !validRawArea(scope.area, scope.project.areaId))
            || !validProject(effect.project.after, request.projectId)
            || !validRawProject(effect.project.before, request.projectId)
            || !same(effect.project.before, scope.project)
            || effect.tasks.some((pair) => !record(pair) || !exact(pair, ['before', 'after'])
                || !validRawTask(pair.before, pair.before.id) || !validRawTask(pair.after, pair.before.id))
            || effect.sections.some((pair) => !record(pair) || !exact(pair, ['before', 'after'])
                || !validSection(pair.before, pair.before.id, request.projectId)
                || !validSection(pair.after, pair.before.id, request.projectId))) return null;
        const expected = projectRestoreEffect(scope,
            prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, prepared.updateAt, prepared.version);
        return same(expected, effect) ? envelope as NativeTrashProjectRestoreEnvelope : null;
    } catch { return null; }
};

export function createTrashProjectRestoreMethods(deps: {
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
    return {
        prepareTrashProjectRestore(input: NativeTrashProjectRestoreRequest): NativeHostResult<NativeTrashProjectRestorePreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Project Restore request is required');
            const state = useTaskStore.getState();
            const target = state._projectsById.get(request.projectId);
            if (!target || !target.deletedAt || target.purgedAt
                || revisionOf(target) !== request.projectRevision)
                return fail('STALE_REVISION', 'Project changed since Trash was read');
            const device = ensureDeviceId(state.settings);
            const scope: PreparedTrashProjectRestore['scope'] = { project: target,
                tasks: state._allTasks.filter((task) => task.projectId === target.id),
                sections: state._allSections.filter((section) => section.projectId === target.id),
                area: state._allAreas.find((area) => area.id === target.areaId) ?? null };
            const updateAt = new Date().toISOString();
            const prepared = detach<NativePreparedTrashProjectRestore>(JSON.parse(JSON.stringify({ version: 2, request, scope,
                effect: projectRestoreEffect(scope, device.deviceId, updateAt),
                deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                updateAt, result: { id: target.id } })));
            return prepared && readPrepared({ request, prepared })
                ? { ok: true, value: { kind: 'prepared', prepared } }
                : fail('INVALID_INPUT', 'Project Restore exceeds the bounded native journal');
        },

        validatePreparedTrashProjectRestore(input: NativeTrashProjectRestoreEnvelope): NativeHostResult<{ id: string }> {
            const envelope = readPrepared(input);
            return envelope ? { ok: true, value: envelope.prepared.result }
                : fail('INVALID_INPUT', 'Prepared Project Restore is malformed');
        },

        async commitPreparedTrashProjectRestore(input: NativeTrashProjectRestoreEnvelope): Promise<NativeHostResult<{ id: string }>> {
            const envelope = readPrepared(input);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared Project Restore is malformed');
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return receipts.run(envelope.request.requestId,
                canonicalPayload(['preparedTrashProjectRestore', envelope]), async () => {
                    const applied = await useTaskStore.getState().commitPreparedTrashProjectRestore(envelope.prepared);
                    return applied.success ? { ok: true, value: envelope.prepared.result }
                        : fail('STALE_REVISION', applied.error ?? 'Prepared Project Restore conflicts with saved data');
                });
        },
    };
}
