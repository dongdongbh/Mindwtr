import { preparePickedAttachment, type PreparedPickedAttachment } from './attachment-editor-model';
import { validateAttachmentForUpload } from './attachment-validation';
import { getManagedAttachmentFileName } from './mobile-attachment-files';
import type { NativeAttachmentDraftPicked } from './native-attachment-draft';
import type { NativeHostResult } from './native-host-contract';
import { createAreaSaveGuard, readAreaDurableData } from './native-host-contract-area-durable';
import {
    isProjectAttachmentWriteProject, isProjectAttachmentWriteToken, projectAttachmentWriteToken,
    type NativeProjectAttachmentWriteResult, type NativeProjectAttachmentWriteToken,
} from './native-host-contract-project-attachments';
import { detach, exact, iso, record } from './native-host-contract-project-shared';
import { taskEditValuesEqual } from './json-value-equality';
import { toAttachments } from './entity-sync-schema';
import { rawReadProjectSnapshot } from './sqlite-raw-snapshot';
import { ensureDeviceId } from './store-helpers';
import { getStorageAdapter, useTaskStore } from './store';
import { projectFileAddLiveRowMatches, projectFileAddScalarCellsMatchWriter, projectFileAddWriteEffect, sameProjectFileAddSqliteRow } from './store-projects/project-actions';
import type { PreparedProjectFileAddWrite } from './store-types';
import type { Attachment, Project } from './types';

type HistoricalProjectFileAddWriteRequest = {
    requestId: string; projectId: string; expected: NativeProjectAttachmentWriteToken;
    picked: NativeAttachmentDraftPicked; measuredSize: number; managedDirectoryURI: string;
};
export type NativeProjectFileAddWriteRequest = HistoricalProjectFileAddWriteRequest
    | (HistoricalProjectFileAddWriteRequest & { version: 2; sourceSha256: string });
export type NativeProjectFileAddWriteResult = NativeProjectAttachmentWriteResult;
export type NativePreparedProjectFileAddWrite = PreparedProjectFileAddWrite & {
    request: NativeProjectFileAddWriteRequest; result: NativeProjectFileAddWriteResult;
    prepared: PreparedPickedAttachment; targetURI: string;
};
export type NativeProjectFileAddWritePreparation =
    | { kind: 'blocked'; result: { blocked: '' } }
    | { kind: 'refused'; result: { message: string } }
    | { kind: 'prepared'; prepared: NativePreparedProjectFileAddWrite };
type Envelope = { request: NativeProjectFileAddWriteRequest; prepared: NativePreparedProjectFileAddWrite };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const same = taskEditValuesEqual;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 500;
const size = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED' | 'ACTION_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const invalid = () => fail('INVALID_INPUT', 'A bounded Project file Add request and exact preparation are required');


const fileURI = (value: unknown, directory = false): value is string => {
    if (typeof value !== 'string' || !value || value.length > 16_384
        || /[?#\\]/.test(value)) return false;
    for (let index = 0; index < value.length; index++) {
        if (value.charCodeAt(index) <= 32 || value.charCodeAt(index) === 127) return false;
    }
    try {
        const parsed = new URL(value);
        const path = decodeURIComponent(parsed.pathname);
        return value.startsWith('file:///') && parsed.toString() === value && !parsed.host
            && !path.includes('\\') && !path.includes('\0')
            && !path.split('/').some((part) => part === '.' || part === '..')
            && (!directory || value.endsWith('/'));
    } catch { return false; }
};
const validPicked = (value: unknown): value is NativeAttachmentDraftPicked => record(value)
    && exact(value, ['uri', 'name', 'mimeType', 'size']) && fileURI(value.uri)
    && (value.name === null || typeof value.name === 'string' && value.name.length <= 100_000)
    && (value.mimeType === null || typeof value.mimeType === 'string' && value.mimeType.length <= 500)
    && (value.size === null || typeof value.size === 'number' && Number.isFinite(value.size) && value.size >= 0);
const readRequest = (value: unknown): NativeProjectFileAddWriteRequest | null => {
    const input = detach<Record<string, unknown>>(value);
    return input && (input.version === 2
        ? exact(input, ['version', 'sourceSha256', 'requestId', 'projectId', 'expected', 'picked', 'measuredSize', 'managedDirectoryURI']) && hash(input.sourceSha256)
        : exact(input, ['requestId', 'projectId', 'expected', 'picked', 'measuredSize', 'managedDirectoryURI']))
        && typeof input.requestId === 'string' && UUID.test(input.requestId) && id(input.projectId)
        && isProjectAttachmentWriteToken(input.expected) && validPicked(input.picked)
        && size(input.measuredSize) && fileURI(input.managedDirectoryURI, true)
        ? input as NativeProjectFileAddWriteRequest : null;
};
const sourceMetadata = (request: NativeProjectFileAddWriteRequest, now: string): Attachment => ({
    id: request.requestId, kind: 'file', title: request.picked.name || 'file', uri: request.picked.uri,
    ...(request.picked.mimeType === null ? {} : { mimeType: request.picked.mimeType }), size: request.measuredSize,
    createdAt: now, updatedAt: now, localStatus: 'available',
    ...('version' in request ? { fileHash: request.sourceSha256 } : {}),
});


const matchesFrozenToken = (before: Project, expected: NativeProjectAttachmentWriteToken): boolean =>
    same(projectAttachmentWriteToken(before), expected)
    || same(projectAttachmentWriteToken({ ...before, attachments: toAttachments(before.attachments) }), expected);


const readPrepared = (value: unknown): NativePreparedProjectFileAddWrite | null => {
    const envelope = detach<Record<string, unknown>>(value);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request);
    const raw = envelope.prepared;
    if (!request || !exact(raw, ['version', 'kind', 'request', 'scope', 'effect', 'deviceIdBefore',
        'deviceIdToInitialize', 'updateAt', 'result', 'prepared', 'targetURI', 'attachment'])
        || raw.version !== ('version' in request ? 4 : 3) || raw.kind !== 'project-file-add' || !same(raw.request, request)
        || !record(raw.scope) || !exact(raw.scope, ['project'])
        || !record(raw.effect) || !exact(raw.effect, ['project']) || !record(raw.effect.project)
        || !exact(raw.effect.project, ['before', 'after'])
        || !(raw.deviceIdBefore === null || id(raw.deviceIdBefore))
        || (raw.deviceIdBefore === null
            ? typeof raw.deviceIdToInitialize !== 'string' || !UUID.test(raw.deviceIdToInitialize)
            : raw.deviceIdToInitialize !== null)
        || !iso(raw.updateAt) || !record(raw.result) || !exact(raw.result, ['id', 'attachmentIds'])
        || raw.result.id !== request.projectId || !same(raw.result.attachmentIds, [request.requestId])
        || !record(raw.prepared) || !exact(raw.prepared, ['kind', 'attachment']) || raw.prepared.kind !== 'prepared'
        || !fileURI(raw.targetURI)) return null;
    try {
        const prepared = raw as unknown as NativePreparedProjectFileAddWrite;
        const before = prepared.scope.project;
        const source = sourceMetadata(request, prepared.updateAt);
        const targetURI = request.managedDirectoryURI + getManagedAttachmentFileName(source);
        const attachment = { ...source, uri: targetURI };
        if (!isProjectAttachmentWriteProject(before, request.projectId)
            || !isProjectAttachmentWriteProject(prepared.effect.project.before, request.projectId)
            || !isProjectAttachmentWriteProject(prepared.effect.project.after, request.projectId)
            || before.status === 'archived' || !matchesFrozenToken(before, request.expected)
            || !same(before, prepared.effect.project.before) || targetURI === source.uri
            || prepared.targetURI !== targetURI || !same(prepared.prepared.attachment, source)
            || !same(prepared.attachment, attachment)) return null;
        const effect = projectFileAddWriteEffect(before, attachment,
            prepared.deviceIdBefore ?? prepared.deviceIdToInitialize!, prepared.updateAt);
        return effect && effect.project.after.rev! > (before.rev ?? 0) && same(effect, prepared.effect)
            && !sameProjectFileAddSqliteRow(before, effect.project.after) ? prepared : null;
    } catch { return null; }
};
const matchesBefore = (current: Project | undefined, prepared: Pick<NativePreparedProjectFileAddWrite,
    'scope' | 'deviceIdBefore'>, deviceId: string | undefined): boolean => !!current && !current.deletedAt && !current.purgedAt
    && current.status !== 'archived' && (deviceId ?? null) === prepared.deviceIdBefore
    && sameProjectFileAddSqliteRow(current, prepared.scope.project);
const matchesAfter = (current: Project | undefined, prepared: NativePreparedProjectFileAddWrite,
    deviceId: string | undefined): boolean => !!current
    && (!prepared.deviceIdToInitialize || deviceId === prepared.deviceIdToInitialize)
    && sameProjectFileAddSqliteRow(current, prepared.effect.project.after);
const selected = (projects: Project[], projectId: string): Project | undefined => {
    const matches = projects.filter((row) => row.id === projectId);
    return matches.length === 1 ? matches[0] : undefined;
};


export function createProjectFileAddWriteMethods(deps: {
    readiness: () => NativeHostResult<null>; save: () => Promise<NativeHostResult<null>>;
    t: () => (key: string) => string;
}) {
    const saves = createAreaSaveGuard(deps.save);
    return {
        probeProjectFileAddWriteOutcome(input: NativeProjectFileAddWriteRequest): NativeHostResult<NativeProjectFileAddWriteResult> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return readRequest(input) ? fail('STALE_REVISION', 'Project file Add outcome is unknown; refresh before trying again') : invalid();
        },

        async prepareProjectFileAddWrite(input: NativeProjectFileAddWriteRequest): Promise<NativeHostResult<NativeProjectFileAddWritePreparation>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return invalid();
            const read = await readAreaDurableData(false, true);
            if (!read.ok) return read;
            const afterReadReady = deps.readiness();
            if (!afterReadReady.ok) return afterReadReady;
            const data = read.value.authority.snapshot;
            const current = selected(data.projects, request.projectId);
            const live = useTaskStore.getState()._projectsById.get(request.projectId);
            if (!current || !live || current.deletedAt || current.purgedAt
                || !projectFileAddScalarCellsMatchWriter(current)
                || !same(projectAttachmentWriteToken(live), request.expected)
                || !projectFileAddLiveRowMatches(live, current)
                || (data.settings.deviceId ?? null) !== (useTaskStore.getState().settings.deviceId ?? null))
                return fail('STALE_REVISION', 'Project changed; refresh before adding a file');
            if (current.status === 'archived') return { ok: true, value: { kind: 'blocked', result: { blocked: '' } } };
            const project = detach<Project>(rawReadProjectSnapshot(current));
            if (!project || !isProjectAttachmentWriteProject(project, request.projectId)
                || (project.attachments?.length ?? 0) >= 1_000) return invalid();
            if (project.attachments?.some((row) => row.id === request.requestId))
                return fail('STALE_REVISION', 'Project file ID is already in use');
            const device = ensureDeviceId(data.settings);
            const captured = { scope: { project }, deviceIdBefore: data.settings.deviceId ?? null };
            let picked: Awaited<ReturnType<typeof preparePickedAttachment>>;
            try {
                picked = await preparePickedAttachment({ source: 'file', asset: { ...request.picked, size: request.measuredSize },
                    newId: () => request.requestId, t: deps.t() });
            } catch { return fail('ACTION_FAILED', 'Could not check Project file policy'); }
            const stillReady = deps.readiness();
            if (!stillReady.ok) return stillReady;
            const checked = await readAreaDurableData(false, true);
            if (!checked.ok) return checked;
            const checkedReady = deps.readiness();
            if (!checkedReady.ok) return checkedReady;
            const checkedData = checked.value.authority.snapshot;
            const latest = selected(checkedData.projects, request.projectId);
            const latestLive = useTaskStore.getState()._projectsById.get(request.projectId);
            if (!matchesBefore(latest, captured, checkedData.settings.deviceId) || !latestLive || !latest
                || !projectFileAddLiveRowMatches(latestLive, latest)
                || !same(projectAttachmentWriteToken(latestLive), request.expected)
                || (checkedData.settings.deviceId ?? null) !== (useTaskStore.getState().settings.deviceId ?? null))
                return fail('STALE_REVISION', 'Project changed while preparing a file');
            if (picked.kind === 'refused') return { ok: true, value: { kind: 'refused', result: { message: picked.message } } };
            let prepared = detach<PreparedPickedAttachment>(JSON.parse(JSON.stringify(picked)));
            if (!prepared) return invalid();
            if ('version' in request) prepared = { ...prepared, attachment: { ...prepared.attachment, fileHash: request.sourceSha256 } };
            const targetURI = request.managedDirectoryURI + getManagedAttachmentFileName(prepared.attachment);
            if (!fileURI(targetURI)) return invalid();

            if (targetURI === request.picked.uri)
                return { ok: true, value: { kind: 'refused', result: { message: deps.t()('attachments.fileNotReadable') } } };
            const attachment = { ...prepared.attachment, uri: targetURI };
            const updateAt = prepared.attachment.createdAt;
            const effect = projectFileAddWriteEffect(project, attachment, device.deviceId, updateAt);
            if (!effect || effect.project.after.rev! <= (project.rev ?? 0)) return invalid();
            const frozen = detach<NativePreparedProjectFileAddWrite>(JSON.parse(JSON.stringify({
                version: 'version' in request ? 4 : 3, kind: 'project-file-add', request, ...captured, effect,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                updateAt, result: { id: project.id, attachmentIds: [request.requestId] }, prepared, targetURI, attachment,
            })));
            return frozen && readPrepared({ request, prepared: frozen })
                ? { ok: true, value: { kind: 'prepared', prepared: frozen } } : invalid();
        },

        validatePreparedProjectFileAddWrite(input: Envelope): NativeHostResult<NativeProjectFileAddWriteResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result } : invalid();
        },

        async commitPreparedProjectFileAddWrite(input: Envelope): Promise<NativeHostResult<NativeProjectFileAddWriteResult>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return invalid();
            let read = await readAreaDurableData(true, true);
            if (!read.ok) return read;
            if (!saves.mayApply(prepared, read.value.adapter)) return fail('SAVE_FAILED', 'Project file Add has unresolved persistence work');
            let data = read.value.authority.snapshot;
            let current = selected(data.projects, prepared.request.projectId);
            const matchesLive = () => {
                const state = useTaskStore.getState(), live = state._projectsById.get(prepared.request.projectId);
                const failedAfter = !!state.persistenceFailure && !!live
                    && projectFileAddLiveRowMatches(live, prepared.effect.project.after)
                    && (!prepared.deviceIdToInitialize || state.settings.deviceId === prepared.deviceIdToInitialize);
                return !!current && !!live && (projectFileAddLiveRowMatches(live, current) || failedAfter)
                    && ((data.settings.deviceId ?? null) === (state.settings.deviceId ?? null) || failedAfter);
            };
            if (!matchesLive()) return fail('STALE_REVISION', 'Project changed while reading saved file data');
            const replay = matchesAfter(current, prepared, data.settings.deviceId);
            if (!replay) {
                if (!matchesBefore(current, prepared, data.settings.deviceId)) return fail('STALE_REVISION', 'Prepared Project file Add conflicts with current data');
                let validation: Awaited<ReturnType<typeof validateAttachmentForUpload>>;
                try { validation = await validateAttachmentForUpload({ ...prepared.prepared.attachment }, prepared.request.measuredSize); }
                catch { return fail('ACTION_FAILED', 'Could not check Project file policy'); }
                const stillReady = deps.readiness();
                if (!stillReady.ok) return stillReady;
                read = await readAreaDurableData(true, true);
                if (!read.ok) return read;
                if (!saves.mayApply(prepared, read.value.adapter)) return fail('SAVE_FAILED', 'Project file Add has unresolved persistence work');
                data = read.value.authority.snapshot;
                current = selected(data.projects, prepared.request.projectId);
                if (!matchesLive()) return fail('STALE_REVISION', 'Project changed while checking file policy');
                if (!matchesAfter(current, prepared, data.settings.deviceId)) {
                    if (!matchesBefore(current, prepared, data.settings.deviceId)) return fail('STALE_REVISION', 'Project changed while checking file policy');
                    if (!validation.valid) return invalid();
                }
            }
            const finalReady = deps.readiness();
            if (!finalReady.ok) return finalReady;
            if (getStorageAdapter() !== read.value.adapter) return fail('STALE_REVISION', 'Project file storage changed');
            const applied = await useTaskStore.getState().commitPreparedProjectFileAddWrite(prepared, read.value.authority);
            if (!applied.success) return fail('STALE_REVISION', 'Prepared Project file Add conflicts with current data');
            const saved = await saves.finish(prepared, read.value.adapter, applied.outcome === 'replayed', read.value.authority.saveBoundary);
            return saved.ok ? { ok: true, value: prepared.result } : fail('SAVE_FAILED', 'Could not save Project file Add');
        },
    };
}
