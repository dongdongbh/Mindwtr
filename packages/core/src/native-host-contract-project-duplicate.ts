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
import { generateDeterministicUUID } from './uuid';

/** The [index]th id a Duplicate under [requestId] allocates (its attachment copies first, then the project, sections and tasks). */
export const projectDuplicateId = (requestId: string, index: number): string => generateDeterministicUUID(`project-duplicate:${requestId}:${index}`);
import { projectDuplicateEffect } from './store-projects/project-actions';
import type { PreparedProjectDuplicate } from './store-types';
import type { Area, Project, Task } from './types';

export type NativeProjectDuplicateRequest = PreparedProjectDuplicate['request'];
export type NativeProjectDuplicateResult = PreparedProjectDuplicate['result'];
export type NativePreparedProjectDuplicate = PreparedProjectDuplicate;
export type NativeProjectDuplicateEnvelope = { request: NativeProjectDuplicateRequest;
    prepared: NativePreparedProjectDuplicate };
export type NativeProjectDuplicatePreparation = { kind: 'prepared'; prepared: NativePreparedProjectDuplicate };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const same = taskEditValuesEqual;
const areaKeys = new Set(AREA_SYNC_FIELD_SCHEMA.map((field) => field.name));
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

const readRequest = (value: unknown): NativeProjectDuplicateRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    return input && isNativeJsonWithinBytes(input, 4_096)
        && exact(input, ['requestId', 'projectId', 'projectRevision'])
        && typeof input.requestId === 'string' && UUID.test(input.requestId)
        && text(input.projectId) && text(input.projectRevision)
        ? input as NativeProjectDuplicateRequest : null;
};
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
const validProjectRow = (value: unknown, id: string): value is Project => validProject(value, id)
    && (value.archivedAt === undefined || iso(value.archivedAt));
const validDevice = (raw: Record<string, unknown>) =>
    (raw.deviceIdBefore === null || typeof raw.deviceIdBefore === 'string' && Boolean(raw.deviceIdBefore))
    && (raw.deviceIdBefore === null
        ? typeof raw.deviceIdToInitialize === 'string' && UUID.test(raw.deviceIdToInitialize)
        : raw.deviceIdToInitialize === null)
    && iso(raw.updateAt);

const readEnvelope = (input: unknown): NativeProjectDuplicateEnvelope | null => {
    const envelope = detach<Record<string, unknown>>(input);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'request', 'scope', 'ids', 'effect',
        'deviceIdBefore', 'deviceIdToInitialize', 'updateAt', 'result'])
        || raw.version !== 1 || !same(raw.request, request)
        || !record(raw.scope) || !exact(raw.scope, ['project', 'sections', 'tasks', 'sameAreaProjects', 'area'])
        || !Array.isArray(raw.scope.sections) || !Array.isArray(raw.scope.tasks)
        || !Array.isArray(raw.scope.sameAreaProjects) || !Array.isArray(raw.ids)
        || !record(raw.effect) || !exact(raw.effect, ['project', 'sections', 'tasks'])
        || !Array.isArray(raw.effect.sections) || !Array.isArray(raw.effect.tasks)
        || !validDevice(raw) || !record(raw.result) || !exact(raw.result, ['id', 'message'])
        || typeof raw.result.message !== 'string' || !raw.result.message || raw.result.message.length > 512)
        return null;
    try {
        const prepared = raw as unknown as NativePreparedProjectDuplicate;
        const { scope, effect, ids } = prepared;
        if (!validProjectRow(scope.project, request.projectId)
            || scope.project.purgedAt || revisionOf(scope.project) !== request.projectRevision
            || !unique(scope.sections) || !unique(scope.tasks) || !unique(scope.sameAreaProjects)
            || scope.sections.some((row) => !validSection(row, row.id, request.projectId))
            || scope.tasks.some((row) => !validTask(row) || row.projectId !== request.projectId)
            || scope.sameAreaProjects.some((row) => !validProjectRow(row, row.id)
                || (row.areaId ?? undefined) !== (scope.project.areaId ?? undefined))
            || scope.sameAreaProjects.filter((row) => row.id === request.projectId).length !== 1
            || !same(scope.sameAreaProjects.find((row) => row.id === request.projectId), scope.project)
            || scope.area !== null && (!scope.project.areaId || !validArea(scope.area, scope.project.areaId))
            || !ids.length || ids.some((id) => typeof id !== 'string' || !UUID.test(id))
            || new Set(ids).size !== ids.length) return null;
        const sourceIds = new Set<string>([
            scope.project.id,
            ...scope.sections.map((row) => row.id), ...scope.tasks.map((row) => row.id),
            ...(scope.project.attachments ?? []).map((row) => row.id),
            ...scope.tasks.flatMap((row) => [
                ...(row.checklist ?? []).map((item) => item.id),
                ...(row.attachments ?? []).map((attachment) => attachment.id),
            ]),
        ]);
        if (ids.some((id) => sourceIds.has(id)) || !validProjectRow(effect.project, effect.project.id)
            || effect.project.id !== prepared.result.id
            || !unique(effect.sections) || !unique(effect.tasks)
            || effect.sections.some((row) => !validSection(row, row.id, effect.project.id))
            || effect.tasks.some((row) => !validTask(row) || row.projectId !== effect.project.id)) return null;
        let index = 0;
        const projected = projectDuplicateEffect(scope,
            prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, prepared.updateAt,
            () => {
                const id = ids[index++];
                if (!id) throw new Error('Missing frozen copy ID');
                return id;
            });
        return index === ids.length && same(projected, effect)
            ? envelope as NativeProjectDuplicateEnvelope : null;
    } catch { return null; }
};

export function createProjectDuplicateMethods(deps: {
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
        prepareProjectDuplicate(input: NativeProjectDuplicateRequest): NativeHostResult<NativeProjectDuplicatePreparation> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded Project Duplicate request is required');
            const state = useTaskStore.getState();
            const source = state._projectsById.get(request.projectId);
            if (!source || source.deletedAt || source.purgedAt
                || revisionOf(source) !== request.projectRevision)
                return fail('STALE_REVISION', 'Project changed since the detail was read');
            const scope: PreparedProjectDuplicate['scope'] = {
                project: source,
                sections: state._allSections.filter((row) => row.projectId === source.id),
                tasks: state._allTasks.filter((row) => row.projectId === source.id),
                sameAreaProjects: state._allProjects.filter((row) => !row.deletedAt
                    && (row.areaId ?? undefined) === (source.areaId ?? undefined)),
                area: state._allAreas.find((row) => row.id === source.areaId) ?? null,
            };
            const device = ensureDeviceId(state.settings);
            const updateAt = new Date().toISOString();
            const ids: string[] = [];
            // The copy's ids come from the request UUID, so a replay after a restart finds the copy it made (never a second one).
            const effect = projectDuplicateEffect(scope, device.deviceId, updateAt, () => {
                const id = projectDuplicateId(request.requestId, ids.length);
                ids.push(id);
                return id;
            });
            const prepared = jsonSafe<PreparedProjectDuplicate>({ version: 1, request, scope, ids, effect,
                deviceIdBefore: state.settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                updateAt, result: { id: effect.project.id,
                    message: resolveI18nText(deps.t(), 'projects.duplicated') } });
            return prepared && readEnvelope({ request, prepared })
                ? { ok: true, value: { kind: 'prepared', prepared } }
                : fail('INVALID_INPUT', 'Project Duplicate exceeds the bounded native journal');
        },
        validatePreparedProjectDuplicate(input: NativeProjectDuplicateEnvelope): NativeHostResult<NativeProjectDuplicateResult> {
            const envelope = readEnvelope(input);
            return envelope ? { ok: true, value: envelope.prepared.result }
                : fail('INVALID_INPUT', 'Prepared Project Duplicate is malformed');
        },
        async commitPreparedProjectDuplicate(input: NativeProjectDuplicateEnvelope): Promise<NativeHostResult<NativeProjectDuplicateResult>> {
            const envelope = readEnvelope(input);
            if (!envelope) return fail('INVALID_INPUT', 'Prepared Project Duplicate is malformed');
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return receipts.run(envelope.request.requestId,
                canonicalPayload(['preparedProjectDuplicate', envelope]), async () => {
                    const applied = await useTaskStore.getState().commitPreparedProjectDuplicate(envelope.prepared);
                    return applied.success ? { ok: true, value: envelope.prepared.result }
                        : fail('STALE_REVISION', applied.error ?? 'Prepared Project Duplicate conflicts with saved data');
                });
        },
    };
}
