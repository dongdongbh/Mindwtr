import type { NativeHostResult } from './native-host-contract';
import { AREA_SYNC_FIELD_SCHEMA, areaToSqliteRow } from './area-sync-schema';
import { resolveI18nText } from './i18n';
import { taskEditValuesEqual } from './json-value-equality';
import { detach, exact, iso, record, validProject } from './native-host-contract-project-shared';
import { validSection } from './native-host-contract-project-section-rename';
import { validRawTask } from './native-host-contract-task-save';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { createNativeRequestReceipts, revisionOf } from './native-request-receipts';
import { ensureDeviceId } from './store-helpers';
import { useTaskStore } from './store';
import { projectDeleteEffect, projectDeleteUndoEffect } from './store-projects/project-actions';
import type { PreparedProjectDelete, PreparedProjectDeleteUndo } from './store-types';
import type { Area, Project, Task } from './types';
import { logInfo } from './logger';

export type NativeProjectDeleteRequest = PreparedProjectDelete['request'];
export type NativeProjectDeleteResult = PreparedProjectDelete['result'];
export type NativePreparedProjectDelete = PreparedProjectDelete & { version: 1 };
export type NativeProjectDeleteEnvelope = { request: NativeProjectDeleteRequest; prepared: NativePreparedProjectDelete };
export type NativeProjectDeletePreparation = { kind: 'prepared'; prepared: NativePreparedProjectDelete };
export type NativeProjectDeleteUndoRequest = PreparedProjectDeleteUndo['request'];
export type NativePreparedProjectDeleteUndo = PreparedProjectDeleteUndo & { version: 1 | 2 };
export type NativeProjectDeleteUndoEnvelope = { request: NativeProjectDeleteUndoRequest;
    prepared: NativePreparedProjectDeleteUndo };
export type NativeProjectDeleteUndoPreparation = { kind: 'prepared'; prepared: NativePreparedProjectDeleteUndo };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const same = taskEditValuesEqual;
const areaKeys = new Set(AREA_SYNC_FIELD_SCHEMA.map((field) => field.name));
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
const notice = (value: unknown, limit: number): value is string => typeof value === 'string'
    && value.length > 0 && value.length <= limit;
const canonicalPayload = (value: unknown): string => JSON.stringify(value, (_key, item) => record(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
    : item);
const unique = (rows: { id: string }[]) => new Set(rows.map((row) => row.id)).size === rows.length;
const jsonSafe = <T,>(value: unknown): T | null => {
    try { return detach<T>(JSON.parse(JSON.stringify(value))); } catch { return null; }
};

const readDeleteRequest = (value: unknown): NativeProjectDeleteRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    return input && isNativeJsonWithinBytes(input, 4_096)
        && (exact(input, ['requestId', 'projectId', 'projectRevision'])
            || exact(input, ['requestId', 'projectId', 'projectRevision', 'source']) && input.source === 'archive')
        && typeof input.requestId === 'string' && UUID.test(input.requestId)
        && text(input.projectId) && text(input.projectRevision)
        ? input as NativeProjectDeleteRequest : null;
};
const readUndoRequest = (value: unknown): NativeProjectDeleteUndoRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    return input && isNativeJsonWithinBytes(input, 4_096)
        && exact(input, ['requestId', 'deleteRequestId'])
        && typeof input.requestId === 'string' && UUID.test(input.requestId)
        && typeof input.deleteRequestId === 'string' && UUID.test(input.deleteRequestId)
        && input.requestId !== input.deleteRequestId
        ? input as NativeProjectDeleteUndoRequest : null;
};

const validDeletedProject = (value: unknown, id: string): value is Project => record(value)
    && iso(value.deletedAt) && value.purgedAt === undefined
    && (value.archivedAt === undefined || iso(value.archivedAt))
    && (value.cancelledAt === undefined || iso(value.cancelledAt))
    && validProject({ ...value, deletedAt: undefined }, id);
const validTask = (value: unknown): value is Task => record(value) && typeof value.id === 'string'
    && validRawTask(value, value.id)
    && (value.deletedAt === undefined || iso(value.deletedAt))
    && (value.purgedAt === undefined || iso(value.purgedAt));
const validArea = (value: unknown, id: string): value is Area => {
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
const validDevice = (raw: Record<string, unknown>) =>
    (raw.deviceIdBefore === null || typeof raw.deviceIdBefore === 'string' && Boolean(raw.deviceIdBefore))
    && (raw.deviceIdBefore === null
        ? typeof raw.deviceIdToInitialize === 'string' && UUID.test(raw.deviceIdToInitialize)
        : raw.deviceIdToInitialize === null)
    && iso(raw.updateAt);

const readDelete = (input: unknown): NativeProjectDeleteEnvelope | null => {
    const envelope = detach<Record<string, unknown>>(input);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readDeleteRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'scope', 'effect', 'deviceIdBefore',
        'deviceIdToInitialize', 'updateAt', 'result']) || raw.version !== 1 || !same(raw.request, request)
        || !record(raw.scope) || !exact(raw.scope, ['project', 'tasks', 'sections'])
        || !Array.isArray(raw.scope.tasks) || !Array.isArray(raw.scope.sections)
        || !record(raw.effect) || !exact(raw.effect, ['project', 'tasks', 'sections'])
        || !record(raw.effect.project) || !exact(raw.effect.project, ['before', 'after'])
        || !Array.isArray(raw.effect.tasks) || !Array.isArray(raw.effect.sections)
        || !validDevice(raw) || !record(raw.result) || !exact(raw.result, ['id', 'deletion'])
        || raw.result.id !== request.projectId || !record(raw.result.deletion)
        || !exact(raw.result.deletion, ['message', 'undoLabel', 'undoEnabled'])
        || !notice(raw.result.deletion.message, 512) || !notice(raw.result.deletion.undoLabel, 80)
        || raw.result.deletion.undoEnabled !== true) return null;
    try {
        const prepared = raw as unknown as NativePreparedProjectDelete;
        const { scope, effect } = prepared;
        if (!validProject(scope.project, request.projectId) || revisionOf(scope.project) !== request.projectRevision
            || (request.source === 'archive' && (scope.project.status !== 'archived'
                || scope.project.archivedAt !== undefined && !iso(scope.project.archivedAt)))
            || !unique(scope.tasks) || !unique(scope.sections)
            || scope.sections.some((row) => !validSection(row, row.id, request.projectId))
            || scope.tasks.some((row) => !validTask(row))
            || !validProject(effect.project.before, request.projectId)
            || !validDeletedProject(effect.project.after, request.projectId)
            || !same(scope.project, effect.project.before)) return null;
        const sectionIds = new Set(scope.sections.map((row) => row.id));
        if (scope.tasks.some((row) => row.projectId !== request.projectId
            && (row.sectionId === undefined || !sectionIds.has(row.sectionId)))
            || effect.tasks.some((pair) => !record(pair) || !exact(pair, ['before', 'after'])
                || !validTask(pair.before) || !validTask(pair.after))
            || effect.sections.some((pair) => !record(pair) || !exact(pair, ['before', 'after'])
                || !validSection(pair.before, pair.before.id, request.projectId)
                || !validSection(pair.after, pair.before.id, request.projectId))) return null;
        return same(projectDeleteEffect(scope,
            prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, prepared.updateAt), effect)
            ? envelope as NativeProjectDeleteEnvelope : null;
    } catch { return null; }
};

const linksFromDelete = (deletion: NativeProjectDeleteEnvelope) => deletion.prepared.effect.tasks.map((pair) => ({
    id: pair.before.id, ...(pair.before.sectionId ? { sectionId: pair.before.sectionId } : {}),
}));

const readUndo = (input: unknown): NativeProjectDeleteUndoEnvelope | null => {
    const envelope = detach<Record<string, unknown>>(input);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readUndoRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'delete', 'scope', 'effect', 'deviceIdBefore',
        'deviceIdToInitialize', 'updateAt', 'result']) || (raw.version !== 1 && raw.version !== 2) || !same(raw.request, request)
        || !record(raw.delete) || !record(raw.scope)
        || !exact(raw.scope, ['project', 'tasks', 'sections', 'area', 'linkedTasks'])
        || !Array.isArray(raw.scope.tasks) || !Array.isArray(raw.scope.sections)
        || !Array.isArray(raw.scope.linkedTasks)
        || !record(raw.effect) || !exact(raw.effect, ['project', 'tasks', 'sections'])
        || !record(raw.effect.project) || !exact(raw.effect.project, ['before', 'after'])
        || !Array.isArray(raw.effect.tasks) || !Array.isArray(raw.effect.sections)
        || !validDevice(raw) || !record(raw.result) || !exact(raw.result, ['id'])) return null;
    const deletion = readDelete(raw.delete);
    if (!deletion || request.deleteRequestId !== deletion.request.requestId
        || !same(raw.delete, deletion) || raw.result.id !== deletion.request.projectId) return null;
    try {
        const prepared = raw as unknown as NativePreparedProjectDeleteUndo;
        const { scope, effect } = prepared;
        if (!validDeletedProject(scope.project, deletion.request.projectId)
            || !same(scope.project, deletion.prepared.effect.project.after)
            || !unique(scope.tasks) || !unique(scope.sections)
            || scope.tasks.some((row) => !validTask(row)
                || row.projectId !== scope.project.id
                    && (row.sectionId === undefined || !scope.sections.some((section) => section.id === row.sectionId)))
            || scope.sections.some((row) => !validSection(row, row.id, scope.project.id))
            || scope.area !== null && (!scope.project.areaId || !validArea(scope.area, scope.project.areaId))
            || !validDeletedProject(effect.project.before, scope.project.id)
            || !validProject(effect.project.after, scope.project.id)
            || !same(effect.project.before, scope.project)) return null;
        const linkIds = linksFromDelete(deletion).map((link) => link.id);
        const linkIdSet = new Set(linkIds);
        if (scope.linkedTasks.length !== linkIds.length || !unique(scope.linkedTasks)
            || scope.linkedTasks.some(({ id, row }) => !linkIdSet.has(id)
                || row !== null && (!validTask(row) || row.id !== id))
            || effect.tasks.some((pair) => !record(pair) || !exact(pair, ['before', 'after'])
                || !validTask(pair.before) || !validTask(pair.after))
            || effect.sections.some((pair) => !record(pair) || !exact(pair, ['before', 'after'])
                || !validSection(pair.before, pair.before.id, scope.project.id)
                || !validSection(pair.after, pair.before.id, scope.project.id))) return null;
        return same(projectDeleteUndoEffect(scope, linksFromDelete(deletion),
            prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, prepared.updateAt, prepared.version), effect)
            ? envelope as NativeProjectDeleteUndoEnvelope : null;
    } catch { return null; }
};

export function createProjectDeleteMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    t: () => (key: string) => string;
}) {
    const receipts = createNativeRequestReceipts({ save: async () => {
        if (useTaskStore.getState().persistenceFailure) {
            try { await useTaskStore.getState().retryPersistence(); }
            catch (error) { return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error)); }
        }
        return deps.save();
    } });
    return {
        prepareProjectDelete(input: NativeProjectDeleteRequest): NativeHostResult<NativeProjectDeletePreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readDeleteRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Project Delete request is required');
            const state = useTaskStore.getState();
            const target = state._projectsById.get(request.projectId);
            if (!target || target.deletedAt || target.purgedAt
                || request.source === 'archive' && target.status !== 'archived'
                || revisionOf(target) !== request.projectRevision)
                return fail('STALE_REVISION', 'Project changed since the detail was read');
            const sections = state._allSections.filter((row) => row.projectId === target.id);
            const sectionIds = new Set(sections.map((row) => row.id));
            const scope: PreparedProjectDelete['scope'] = { project: target, sections,
                tasks: state._allTasks.filter((row) => row.projectId === target.id
                    || row.sectionId !== undefined && sectionIds.has(row.sectionId)) };
            const device = ensureDeviceId(state.settings);
            const updateAt = new Date().toISOString();
            const t = deps.t();
            const prepared = jsonSafe<NativePreparedProjectDelete>({ version: 1, request, scope,
                effect: projectDeleteEffect(scope, device.deviceId, updateAt),
                deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                updateAt, result: { id: target.id, deletion: {
                    message: resolveI18nText(t, 'projects.deleted'),
                    undoLabel: resolveI18nText(t, 'common.undo'), undoEnabled: true,
                } } });
            return prepared && readDelete({ request, prepared })
                ? { ok: true, value: { kind: 'prepared', prepared } }
                : fail('INVALID_INPUT', 'Project Delete exceeds the bounded native journal');
        },
        validatePreparedProjectDelete(input: NativeProjectDeleteEnvelope): NativeHostResult<NativeProjectDeleteResult> {
            const envelope = readDelete(input);
            return envelope ? { ok: true, value: envelope.prepared.result }
                : fail('INVALID_INPUT', 'Prepared Project Delete is malformed');
        },
        /** Exact durable UUID/effect receipt only; an equal target row is not proof. */
        projectDeleteOutcome(input: NativeProjectDeleteEnvelope): NativeHostResult<NativeProjectDeleteResult | null> {
            const envelope = readDelete(input);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared Project Delete is malformed');
            const saved = receipts.saved<NativeProjectDeleteResult>(envelope.request.requestId,
                canonicalPayload(['preparedProjectDelete', envelope]));
            if (saved?.ok && !same(saved.value, envelope.prepared.result))
                return fail('INVALID_INPUT', 'Saved Project Delete result does not match the prepared request');
            return saved === null ? { ok: true, value: null } : saved;
        },
        async commitPreparedProjectDelete(input: NativeProjectDeleteEnvelope): Promise<NativeHostResult<NativeProjectDeleteResult>> {
            const envelope = readDelete(input);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared Project Delete is malformed');
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const payload = canonicalPayload(['preparedProjectDelete', envelope]);
            const alreadySaved = receipts.saved<NativeProjectDeleteResult>(envelope.request.requestId, payload);
            const confirmed = await receipts.run(envelope.request.requestId, payload, async () => {
                    const applied = await useTaskStore.getState().commitPreparedProjectDelete(envelope.prepared);
                    return applied.success ? { ok: true, value: envelope.prepared.result }
                        : fail('STALE_REVISION', applied.error ?? 'Prepared Project Delete conflicts with saved data');
                });
            if (confirmed.ok && !alreadySaved?.ok) {
                try { logInfo('Native Project delete taxonomy retained', { scope: 'native-host', category: 'storage',
                    context: { releaseCheck: 'v1.3.7/native-project-delete-taxonomy', operation: 'delete', outcome: 'confirmed' } }); }
                catch { /* Diagnostics cannot invalidate a durable acknowledgment. */ }
            }
            if (confirmed.ok && envelope.request.source === 'archive' && !alreadySaved?.ok) {
                try { logInfo('Native archived Project delete confirmed', { scope: 'native-host', category: 'storage',
                    context: { releaseCheck: 'v1.3.4/ios-archive-project-trash', outcome: 'confirmed' } }); }
                catch { /* Diagnostics cannot invalidate a durable acknowledgment. */ }
            }
            return confirmed;
        },
        prepareProjectDeleteUndo(input: { request: NativeProjectDeleteUndoRequest;
            delete: NativeProjectDeleteEnvelope }): NativeHostResult<NativeProjectDeleteUndoPreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readUndoRequest(input?.request);
            const deletion = readDelete(input?.delete);
            if (!request || !deletion || request.deleteRequestId !== deletion.request.requestId)
                return fail('INVALID_INPUT', 'A confirmed Project Delete and new Undo UUID are required');
            const state = useTaskStore.getState();
            const target = state._projectsById.get(deletion.request.projectId);
            if (!target || !target.deletedAt || target.purgedAt
                || !same(target, deletion.prepared.effect.project.after))
                return fail('STALE_REVISION', 'Project Delete was superseded');
            const links = linksFromDelete(deletion);
            const linkIds = new Set(links.map((link) => link.id));
            const currentLinks = state._allTasks.filter((row) => linkIds.has(row.id));
            const presentLinkIds = new Set(currentLinks.map((row) => row.id));
            const sections = state._allSections.filter((row) => row.projectId === target.id);
            const sectionIds = new Set(sections.map((row) => row.id));
            const scope: PreparedProjectDeleteUndo['scope'] = { project: target,
                tasks: state._allTasks.filter((row) => row.projectId === target.id
                    || row.sectionId !== undefined && sectionIds.has(row.sectionId)),
                sections,
                area: state._allAreas.find((row) => row.id === target.areaId) ?? null,
                // RN batchUpdateTasks reserves Project order in current Task-array
                // order, even when the original Delete link list had another order.
                linkedTasks: [...currentLinks.map((row) => ({ id: row.id, row })),
                    ...links.filter(({ id }) => !presentLinkIds.has(id)).map(({ id }) => ({ id, row: null }))] };
            const device = ensureDeviceId(state.settings);
            const updateAt = new Date().toISOString();
            const prepared = jsonSafe<NativePreparedProjectDeleteUndo>({ version: 2, request, delete: deletion,
                scope, effect: projectDeleteUndoEffect(scope, links, device.deviceId, updateAt),
                deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                updateAt, result: { id: target.id } });
            return prepared && readUndo({ request, prepared })
                ? { ok: true, value: { kind: 'prepared', prepared } }
                : fail('INVALID_INPUT', 'Project Delete Undo exceeds the bounded native journal');
        },
        validatePreparedProjectDeleteUndo(input: NativeProjectDeleteUndoEnvelope): NativeHostResult<{ id: string }> {
            const envelope = readUndo(input);
            return envelope ? { ok: true, value: envelope.prepared.result }
                : fail('INVALID_INPUT', 'Prepared Project Delete Undo is malformed');
        },
        async commitPreparedProjectDeleteUndo(input: NativeProjectDeleteUndoEnvelope): Promise<NativeHostResult<{ id: string }>> {
            const envelope = readUndo(input);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared Project Delete Undo is malformed');
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const payload = canonicalPayload(['preparedProjectDeleteUndo', envelope]);
            const alreadySaved = receipts.saved<{ id: string }>(envelope.request.requestId, payload);
            const confirmed = await receipts.run(envelope.request.requestId, payload, async () => {
                    const applied = await useTaskStore.getState().commitPreparedProjectDeleteUndo(envelope.prepared);
                    return applied.success ? { ok: true, value: envelope.prepared.result }
                        : fail('STALE_REVISION', applied.error ?? 'Prepared Project Delete Undo conflicts with saved data');
                });
            if (confirmed.ok && !alreadySaved?.ok) {
                try { logInfo('Native Project delete taxonomy retained', { scope: 'native-host', category: 'storage',
                    context: { releaseCheck: 'v1.3.7/native-project-delete-taxonomy', operation: 'undo', outcome: 'confirmed' } }); }
                catch { /* Diagnostics cannot invalidate a durable acknowledgment. */ }
            }
            return confirmed;
        },
    };
}
