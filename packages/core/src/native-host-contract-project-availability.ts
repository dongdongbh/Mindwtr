import type { NativeHostResult } from './native-host-contract';
import { readNativeAttachments, type NativeAttachmentResolution, type NativeAttachmentsHost } from './native-host-contract-attachments';
import { readProjectAttachmentEditOptions, projectAttachmentWriteToken } from './native-host-contract-project-attachments';
import { readAreaDurableData, createAreaSaveGuard } from './native-host-contract-area-durable';
import { detach, exact, iso, record } from './native-host-contract-project-shared';
import { getAttachmentDownloadFileName } from './mobile-attachment-availability';
import { getStorageAdapter, getPersistenceStatus, useTaskStore } from './store';
import { rawReadProjectSnapshot, rawReadRow, rememberRawReadRow } from './sqlite-raw-snapshot';
import { PROJECT_SQLITE_COLUMNS, projectFromSqliteRow, projectToSqliteRow } from './project-sync-schema';
import { ensureDeviceId } from './store-helpers';
import { taskEditValuesEqual as same } from './json-value-equality';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { projectAvailabilityWritePlan, projectFileAvailabilityWritePlan, sameProjectAvailabilityRawRow, projectFileAddLiveRowMatches,
    projectFileAddScalarCellsMatchWriter, projectWebDavAvailabilityWritePlan } from './store-projects/project-actions';
import type { Attachment, Project } from './types';
import type { SelectedProjectAvailabilityWrite } from './store-types';

type Request = { projectId: string; attachmentId: string; revision: string; managedDirectoryURI: string };
type Deps = { readiness: () => NativeHostResult<null>; revision: () => string;
    save: () => Promise<NativeHostResult<null>>; host: () => NativeAttachmentsHost | null };
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED' | 'ACTION_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const invalid = () => fail('INVALID_INPUT', 'A bounded selected Project availability request is required');
const stale = () => fail('STALE_REVISION', 'Selected Project availability changed');
const savedFailure = () => fail('SAVE_FAILED', 'Selected Project availability could not be confirmed');
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && !!value && value.length <= limit;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const fileURI = (value: unknown, directory = false): value is string => {
    if (!text(value, 16_384) || /[?#\\]/.test(value)
        || [...value].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) return false;
    try {
        const url = new URL(value), path = decodeURIComponent(url.pathname);
        return value.startsWith('file:///') && url.toString() === value && !url.host
            && !path.includes('\\') && !path.includes('\0') && !path.split('/').some((part) => part === '.' || part === '..')
            && (!directory || value.endsWith('/'));
    } catch { return false; }
};
const readRequest = (input: unknown): Request | null => record(input)
    && exact(input, ['projectId', 'attachmentId', 'revision', 'managedDirectoryURI'])
    && text(input.projectId, 500) && typeof input.attachmentId === 'string' && uuid.test(input.attachmentId)
    && text(input.revision, 200) && fileURI(input.managedDirectoryURI, true)
    ? { ...input } as Request : null;
const idle = (): boolean => {
    const status = getPersistenceStatus();
    return !useTaskStore.getState().persistenceFailure && !status.queued && !status.inFlight && !status.immediate && !status.retrying;
};
const selectedProject = (projects: Project[], id: string): Project | undefined => {
    const matches = projects.filter((item) => item.id === id);
    return matches.length === 1 ? matches[0] : undefined;
};

export function createProjectAvailabilityMethods(deps: Deps, mode: 'relocated' | 'cached' | 'cached-webdav' = 'relocated') {
    const saves = createAreaSaveGuard(deps.save);
    const webdav = mode === 'cached-webdav', cached = mode !== 'relocated';
    // The filename derivation is pure; this selection reads settled durable rows,
    // preserving metadata the display codec omits (for example explicit false).
    const preflight = async (input: Request) => {
        const ready = deps.readiness();
        if (!ready.ok) return ready;
        if (!idle()) return savedFailure();
        const options = readProjectAttachmentEditOptions(deps, { projectId: input.projectId });
        if (!options.ok) return options;
        if (options.value.revision !== input.revision) return stale();
        const read = await readAreaDurableData(false, true);
        if (!read.ok) return read;
        if (!idle() || !('concurrentWritesGuarded' in read.value.adapter) || read.value.adapter.concurrentWritesGuarded !== true)
            return savedFailure();
        const current = selectedProject(read.value.authority.snapshot.projects, input.projectId);
        const live = useTaskStore.getState()._projectsById.get(input.projectId);
        if (!current || !live || current.deletedAt || current.purgedAt || !projectFileAddScalarCellsMatchWriter(current)
            || !projectFileAddLiveRowMatches(live, current) || deps.revision() !== input.revision) return stale();
        const before = rawReadProjectSnapshot(current);
        const attachments = before && readNativeAttachments(before.attachments);
        const matches = attachments?.filter((item) => item.id === input.attachmentId) ?? [];
        const attachment = matches.length === 1 ? matches[0] : undefined;
        if (!before || !attachment || attachment.kind !== 'file' || attachment.deletedAt
            || mode === 'relocated' && !fileURI(attachment.uri)
            || (!webdav || attachment.fileHash !== undefined) && (typeof attachment.fileHash !== 'string' || !/^[0-9a-f]{64}$/i.test(attachment.fileHash))) return invalid();
        const targetURI = input.managedDirectoryURI + getAttachmentDownloadFileName(attachment);
        if (!fileURI(targetURI) || targetURI.slice(input.managedDirectoryURI.length).includes('/')
            || (cached ? attachment.uri !== '' && attachment.uri !== targetURI
                || !webdav && attachment.uri === targetURI && attachment.localStatus === 'available' : targetURI === attachment.uri))
            return invalid();
        if ((read.value.authority.snapshot.settings.deviceId ?? null) !== (useTaskStore.getState().settings.deviceId ?? null)) return stale();
        const value = { revision: input.revision, project: { id: before.id, ...projectAttachmentWriteToken(before) }, targetURI };
        return isNativeJsonWithinBytes(value) ? { ok: true as const, value: { read: read.value, before, attachment, value } } : invalid();
    };
    return {
        async getProjectAttachmentAvailabilityPreflight(raw: Request) {
            const input = readRequest(raw);
            if (!input) return invalid();
            const result = await preflight(input);
            return result.ok ? { ok: true as const, value: result.value.value } : result;
        },
        async downloadRelocatedProjectAttachment(raw: Request, currentTargetURI: string): Promise<NativeHostResult<NativeAttachmentResolution>> {
            const input = readRequest(raw);
            if (!input || !fileURI(currentTargetURI)) return invalid();
            const captured = await preflight(input);
            if (!captured.ok) return captured;
            const initial = captured.value;
            if (currentTargetURI !== initial.value.targetURI) return invalid();
            const host = deps.host();
            if (!host) return fail('ACTION_FAILED', 'Project availability is unavailable');
            const beforeCells = [...rawReadRow(selectedProject(initial.read.authority.snapshot.projects, input.projectId)!,
                projectToSqliteRow(selectedProject(initial.read.authority.snapshot.projects, input.projectId)!)).row];
            const deviceIdBefore = initial.read.authority.snapshot.settings.deviceId ?? null;
            let outcome;
            try { outcome = await host.ensureAttachmentAvailableDetailed({ ...initial.attachment, uri: currentTargetURI }); }
            catch { return fail('ACTION_FAILED', 'Project availability is unavailable'); }
            if (outcome.status !== 'available') return { ok: true, value: { status: 'generation-conflict', message: null, update: null } };
            if (!same(outcome.attachment, { ...initial.attachment, uri: currentTargetURI, localStatus: 'available' })) return invalid();
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!idle()) return savedFailure();
            const fresh = await readAreaDurableData(false, true);
            if (!fresh.ok) return fresh;
            const current = selectedProject(fresh.value.authority.snapshot.projects, input.projectId);
            const live = useTaskStore.getState()._projectsById.get(input.projectId);
            if (fresh.value.adapter !== initial.read.adapter || !current || !live || !projectFileAddLiveRowMatches(live, current)
                || !sameProjectAvailabilityRawRow(current, beforeCells)
                || !same(rawReadProjectSnapshot(current), initial.before)
                || (fresh.value.authority.snapshot.settings.deviceId ?? null) !== deviceIdBefore
                || (useTaskStore.getState().settings.deviceId ?? null) !== deviceIdBefore) return stale();
            const noop = webdav && initial.attachment.uri === currentTargetURI && initial.attachment.localStatus === 'available';
            const device = noop ? { updated: false, deviceId: deviceIdBefore } : ensureDeviceId(fresh.value.authority.snapshot.settings);
            const stamp = noop ? initial.before.updatedAt! : new Date().toISOString();
            const plan = webdav ? projectWebDavAvailabilityWritePlan(initial.before, beforeCells, input.attachmentId, currentTargetURI,
                deviceIdBefore, device.updated ? device.deviceId : null, stamp, 'available')
                : (cached ? projectFileAvailabilityWritePlan : projectAvailabilityWritePlan)(
                    initial.before, beforeCells, input.attachmentId, currentTargetURI,
                    deviceIdBefore, device.updated ? device.deviceId : null, stamp);
            if (!plan || plan.outcome !== 'noop' && !saves.mayApply(plan, fresh.value.adapter) || !idle()) return savedFailure();
            const applied = await (cached
                ? useTaskStore.getState().commitPreparedProjectFileAvailability(plan, fresh.value.authority)
                : useTaskStore.getState().commitSelectedProjectAvailability(plan, fresh.value.authority));
            if (!applied.success) return stale();
            if (applied.outcome !== 'replayed') {
                const saved = await saves.finish(plan, fresh.value.adapter, false, fresh.value.authority.saveBoundary);
                if (!saved.ok) return savedFailure();
            }
            if (getStorageAdapter() !== fresh.value.adapter || !idle()) return savedFailure();
            const after = await readAreaDurableData(false, true);
            if (!after.ok) return after;
            const actual = selectedProject(after.value.authority.snapshot.projects, input.projectId);
            const actualLive = useTaskStore.getState()._projectsById.get(input.projectId);
            if (after.value.adapter !== fresh.value.adapter || !actual || !actualLive
                || !sameProjectAvailabilityRawRow(actual, plan.rawAfter) || !projectFileAddLiveRowMatches(actualLive, actual)
                || (after.value.authority.snapshot.settings.deviceId ?? null) !== (plan.deviceIdBefore ?? plan.deviceIdToInitialize)
                || !idle()) return savedFailure();
            return { ok: true, value: { status: 'available', message: null, update: null } };
        },
    };
}

export type NativeProjectFileAvailabilitySelection = Request & { version: 1; requestId: string };
export type NativeProjectFileAvailabilityRequest = NativeProjectFileAvailabilitySelection & { sha256: string; size: number };
export type NativeProjectFileAvailabilityPreflight = { version: 1; requestId: string; revision: string;
    project: Project; rawBefore: unknown[]; attachmentJSON: string; targetURI: string; deviceIdBefore: string | null };
export type NativeProjectFileAvailabilityEnvelope = { request: NativeProjectFileAvailabilityRequest; prepared: {
    version: 1; kind: 'project-file-availability'; attachmentJSON: string; targetURI: string;
    expectation: { kind: 'absent' }; effect: SelectedProjectAvailabilityWrite;
    result: { status: 'available'; message: null; update: null };
} };

type NativeProjectFileUnrecoverableRequest = NativeProjectFileAvailabilitySelection & { unrecoverableAt: string };
type NativeProjectFileUnrecoverableEnvelope = { request: NativeProjectFileUnrecoverableRequest; prepared: {
    version: 2; kind: 'project-file-unrecoverable'; attachmentJSON: string; targetURI: string;
    expectation: { kind: 'metadata-only' }; effect: SelectedProjectAvailabilityWrite;
    result: { status: 'unrecoverable'; message: string; update: null };
} };
const readUnrecoverableRequest = (raw: unknown): NativeProjectFileUnrecoverableRequest | null => {
    const value = detach<Record<string, unknown>>(raw);
    if (!value || !exact(value, [...selectionKeys, 'unrecoverableAt']) || !iso(value.unrecoverableAt)) return null;
    const { unrecoverableAt, ...selection } = value;
    return readFileAvailabilityRequest(selection, false) ? { ...selection, unrecoverableAt } as NativeProjectFileUnrecoverableRequest : null;
};

const invalidFileAvailability = () => fail('INVALID_INPUT', 'A bounded prepared Project file availability envelope is required');
const availableResult = () => ({ status: 'available' as const, message: null, update: null });
const sourceSize = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)
    && value >= 0 && value <= 8_388_608;
const sourceHash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const selectionKeys = ['version', 'requestId', 'projectId', 'attachmentId', 'revision', 'managedDirectoryURI'];
const readFileAvailabilityRequest = (value: unknown, measured: boolean) => {
    const input = detach<Record<string, unknown>>(value);
    if (!input || !exact(input, [...selectionKeys, ...(measured ? ['sha256', 'size'] : [])])
        || input.version !== 1 || typeof input.requestId !== 'string' || !uuid.test(input.requestId)
        || !readRequest({ projectId: input.projectId, attachmentId: input.attachmentId,
            revision: input.revision, managedDirectoryURI: input.managedDirectoryURI })
        || measured && (!sourceHash(input.sha256) || !sourceSize(input.size))) return null;
    return input as NativeProjectFileAvailabilityRequest;
};
const fileAvailabilityTarget = (attachment: Attachment, directory: string, webdav = false): string | null => {
    if ((!webdav || attachment.fileHash !== undefined) && (typeof attachment.fileHash !== 'string' || !/^[0-9a-f]{64}$/i.test(attachment.fileHash))
        || attachment.size !== undefined && !sourceSize(attachment.size)) return null;
    const target = directory + getAttachmentDownloadFileName(attachment);
    return fileURI(target) && !target.slice(directory.length).includes('/')
        && (webdav || attachment.uri !== target || attachment.localStatus !== 'available') ? target : null;
};
// Rebuild only from exact SQL cells. Object-key ordering in a native journal
// never rewrites the opaque raw attachment string or changes its frozen plan.
const fileAvailabilityRawBefore = (value: unknown): Project | null => {
    if (!Array.isArray(value) || value.length !== PROJECT_SQLITE_COLUMNS.length
        || !value.every(cell => cell === null || typeof cell === 'string' || typeof cell === 'number' && Number.isFinite(cell))) return null;
    try {
        const row = Object.fromEntries(PROJECT_SQLITE_COLUMNS.map((column, index) => [column, value[index]]));
        const project = projectFromSqliteRow(row);
        rememberRawReadRow(project, row, PROJECT_SQLITE_COLUMNS, projectToSqliteRow(project));
        return projectFileAddScalarCellsMatchWriter(project) && iso(project.createdAt) && iso(project.updatedAt)
            ? rawReadProjectSnapshot(project) : null;
    } catch { return null; }
};
/** Pure cold-journal validation; no readiness, clock, mutable store or byte authority. */
const readPreparedFileAvailability = (value: unknown, webdav = false): NativeProjectFileAvailabilityEnvelope | null => {
    const envelope = detach<NativeProjectFileAvailabilityEnvelope>(value);
    if (!envelope || !record(envelope) || !exact(envelope, ['request', 'prepared'])) return null;
    const request = readFileAvailabilityRequest(envelope.request, true), prepared = envelope.prepared;
    if (!request || !record(prepared) || !exact(prepared, ['version', 'kind', 'attachmentJSON', 'targetURI', 'expectation', 'effect', 'result'])
        || prepared.version !== 1 || prepared.kind !== 'project-file-availability'
        || !record(prepared.expectation) || !exact(prepared.expectation, ['kind']) || prepared.expectation.kind !== 'absent'
        || !record(prepared.effect) || !exact(prepared.effect, ['projectId', 'attachmentId', 'targetURI', 'before', 'after',
            'rawBefore', 'rawAfter', 'deviceIdBefore', 'deviceIdToInitialize', 'updateAt', ...(webdav && prepared.effect.outcome !== undefined ? ['outcome'] : [])])
        || !record(prepared.result) || !exact(prepared.result, ['status', 'message', 'update'])
        || !same(prepared.result, availableResult())) return null;
    const effect = prepared.effect, before = fileAvailabilityRawBefore(effect.rawBefore);
    if (!before || before.id !== request.projectId || !same(effect.before, before)
        || !(effect.deviceIdBefore === null || text(effect.deviceIdBefore, 500))
        || (effect.outcome === 'noop' ? !webdav || effect.deviceIdToInitialize !== null : effect.deviceIdBefore === null
            ? typeof effect.deviceIdToInitialize !== 'string' || !uuid.test(effect.deviceIdToInitialize)
            : effect.deviceIdToInitialize !== null) || !iso(effect.updateAt)) return null;
    const attachments = readNativeAttachments(before.attachments), selected = attachments?.find(item => item.id === request.attachmentId);
    if (!selected || selected.kind !== 'file' || selected.deletedAt
        || !sourceHash(request.sha256) || (!webdav || selected.fileHash !== undefined) && request.sha256 !== selected.fileHash?.toLowerCase()
        || selected.size !== undefined && selected.size !== request.size
        || prepared.attachmentJSON !== JSON.stringify(selected)) return null;
    const target = fileAvailabilityTarget(selected, request.managedDirectoryURI, webdav);
    const planned = target && (webdav ? projectWebDavAvailabilityWritePlan(before, effect.rawBefore, request.attachmentId,
        target, effect.deviceIdBefore, effect.deviceIdToInitialize, effect.updateAt, 'available')
        : projectFileAvailabilityWritePlan(before, effect.rawBefore, request.attachmentId,
            target, effect.deviceIdBefore, effect.deviceIdToInitialize, effect.updateAt));
    // Keep the proven raw-cell reconstruction for commit; native object-key sorting
    // must not change the later attachment STRING serialization.
    return planned && prepared.targetURI === target && same(effect, planned)
        ? { ...envelope, prepared: { ...prepared, effect: planned } } : null;
};

/** Source-free404 validation has no file/publication authority. */
const readPreparedUnrecoverable = (raw: unknown): NativeProjectFileUnrecoverableEnvelope | null => {
    const envelope = detach<NativeProjectFileUnrecoverableEnvelope>(raw);
    if (!envelope || !record(envelope) || !exact(envelope, ['request', 'prepared'])) return null;
    const request = readUnrecoverableRequest(envelope.request), prepared = envelope.prepared;
    if (!request || !record(prepared) || !exact(prepared, ['version', 'kind', 'attachmentJSON', 'targetURI', 'expectation', 'effect', 'result'])
        || prepared.version !== 2 || prepared.kind !== 'project-file-unrecoverable'
        || !record(prepared.expectation) || !exact(prepared.expectation, ['kind']) || prepared.expectation.kind !== 'metadata-only'
        || !record(prepared.effect) || !exact(prepared.effect, ['projectId', 'attachmentId', 'targetURI', 'before', 'after',
            'rawBefore', 'rawAfter', 'deviceIdBefore', 'deviceIdToInitialize', 'updateAt', 'outcome'])
        || !record(prepared.result) || !exact(prepared.result, ['status', 'message', 'update'])
        || prepared.result.status !== 'unrecoverable' || prepared.result.update !== null || !text(prepared.result.message, 2_000)) return null;
    const effect = prepared.effect, before = fileAvailabilityRawBefore(effect.rawBefore);
    if (!before || before.id !== request.projectId || !same(effect.before, before) || effect.outcome !== 'unrecoverable'
        || effect.updateAt !== request.unrecoverableAt
        || !(effect.deviceIdBefore === null || text(effect.deviceIdBefore, 500))
        || (effect.deviceIdBefore === null ? typeof effect.deviceIdToInitialize !== 'string' || !uuid.test(effect.deviceIdToInitialize)
            : effect.deviceIdToInitialize !== null)) return null;
    const selected = readNativeAttachments(before.attachments)?.find(item => item.id === request.attachmentId);
    if (!selected || selected.kind !== 'file' || selected.deletedAt || prepared.attachmentJSON !== JSON.stringify(selected)) return null;
    const target = fileAvailabilityTarget(selected, request.managedDirectoryURI, true);
    const planned = target && projectWebDavAvailabilityWritePlan(before, effect.rawBefore, request.attachmentId,
        target, effect.deviceIdBefore, effect.deviceIdToInitialize, effect.updateAt, 'unrecoverable');
    return planned && prepared.targetURI === target && same(effect, planned)
        ? { ...envelope, prepared: { ...prepared, effect: planned } } : null;
};

/** Private native prerequisite, deliberately not installed on the public contract.
 * Preparation grants metadata intent only; native must prove absence/publication. */
export function createPreparedProjectAvailabilityMethods(deps: Pick<Deps, 'readiness' | 'revision' | 'save'> & { translate?: (key: string) => string }, mode: 'strict' | 'webdav' = 'strict') {
    const webdav = mode === 'webdav';
    const readEnvelope = (raw: unknown) => webdav && record(raw) && record(raw.prepared) && raw.prepared.version === 2
        ? readPreparedUnrecoverable(raw) : readPreparedFileAvailability(raw, webdav);
    const saves = createAreaSaveGuard(deps.save);
    const select = async (input: NativeProjectFileAvailabilitySelection) => {
        const ready = deps.readiness(); if (!ready.ok) return ready;
        if (!idle()) return savedFailure();
        const options = readProjectAttachmentEditOptions(deps, { projectId: input.projectId });
        if (!options.ok) return options;
        if (options.value.revision !== input.revision) return stale();
        const read = await readAreaDurableData(false, true); if (!read.ok) return read;
        const afterRead = deps.readiness(); if (!afterRead.ok) return afterRead;
        if (!idle() || !('concurrentWritesGuarded' in read.value.adapter) || read.value.adapter.concurrentWritesGuarded !== true)
            return savedFailure();
        const current = selectedProject(read.value.authority.snapshot.projects, input.projectId);
        const live = useTaskStore.getState()._projectsById.get(input.projectId);
        if (!current || !live || current.deletedAt || current.purgedAt || !projectFileAddScalarCellsMatchWriter(current)
            || !projectFileAddLiveRowMatches(live, current) || deps.revision() !== input.revision) return stale();
        const before = rawReadProjectSnapshot(current), attachments = before && readNativeAttachments(before.attachments);
        const attachment = attachments?.find(item => item.id === input.attachmentId);
        if (!before || !attachment || attachment.kind !== 'file' || attachment.deletedAt) return invalidFileAvailability();
        const targetURI = fileAvailabilityTarget(attachment, input.managedDirectoryURI, webdav);
        if (!targetURI) return invalidFileAvailability();
        const deviceIdBefore = read.value.authority.snapshot.settings.deviceId ?? null;
        if (deviceIdBefore !== (useTaskStore.getState().settings.deviceId ?? null)
            || deviceIdBefore !== null && !text(deviceIdBefore, 500)) return stale();
        const rawBefore = [...rawReadRow(current, projectToSqliteRow(current)).row];
        return { ok: true as const, value: { before, rawBefore, attachment, targetURI, deviceIdBefore,
            settings: read.value.authority.snapshot.settings } };
    };
    return {
        async getProjectFileAvailabilityPreflight(raw: unknown): Promise<NativeHostResult<NativeProjectFileAvailabilityPreflight>> {
            const input = readFileAvailabilityRequest(raw, false); if (!input) return invalidFileAvailability();
            const selected = await select(input); if (!selected.ok) return selected;
            const initial = selected.value;
            const result: NativeProjectFileAvailabilityPreflight = { version: 1, requestId: input.requestId, revision: input.revision,
                project: initial.before, rawBefore: initial.rawBefore, attachmentJSON: JSON.stringify(initial.attachment),
                targetURI: initial.targetURI, deviceIdBefore: initial.deviceIdBefore };
            const frozen = detach<NativeProjectFileAvailabilityPreflight>(result);
            return frozen ? { ok: true, value: frozen } : invalidFileAvailability();
        },
        async prepareProjectFileAvailability(raw: unknown): Promise<NativeHostResult<NativeProjectFileAvailabilityEnvelope>> {
            const input = readFileAvailabilityRequest(raw, true); if (!input) return invalidFileAvailability();
            const selected = await select(input); if (!selected.ok) return selected;
            const initial = selected.value;
            if ((!webdav || initial.attachment.fileHash !== undefined) && input.sha256 !== initial.attachment.fileHash?.toLowerCase()
                || initial.attachment.size !== undefined && input.size !== initial.attachment.size) return invalidFileAvailability();
            const noop = webdav && initial.attachment.uri === initial.targetURI && initial.attachment.localStatus === 'available';
            const device = noop ? { updated: false, deviceId: initial.deviceIdBefore } : ensureDeviceId(initial.settings);
            const stamp = noop ? initial.before.updatedAt! : new Date().toISOString();
            const effect = webdav ? projectWebDavAvailabilityWritePlan(initial.before, initial.rawBefore, input.attachmentId,
                initial.targetURI, initial.deviceIdBefore, device.updated ? device.deviceId : null, stamp, 'available')
                : projectFileAvailabilityWritePlan(initial.before, initial.rawBefore, input.attachmentId,
                    initial.targetURI, initial.deviceIdBefore, device.updated ? device.deviceId : null, stamp);
            if (!effect) return invalidFileAvailability();
            const envelope: NativeProjectFileAvailabilityEnvelope = { request: input, prepared: { version: 1,
                kind: 'project-file-availability', attachmentJSON: JSON.stringify(initial.attachment), targetURI: initial.targetURI,
                expectation: { kind: 'absent' }, effect, result: availableResult() } };
            const frozen = readPreparedFileAvailability(envelope, webdav);
            return frozen ? { ok: true, value: frozen } : invalidFileAvailability();
        },
        async prepareProjectFileUnrecoverable(raw: unknown): Promise<NativeHostResult<NativeProjectFileUnrecoverableEnvelope>> {
            const input = webdav && readUnrecoverableRequest(raw); if (!input) return invalidFileAvailability();
            const selected = await select(input); if (!selected.ok) return selected;
            const initial = selected.value, device = ensureDeviceId(initial.settings);
            const effect = projectWebDavAvailabilityWritePlan(initial.before, initial.rawBefore, input.attachmentId,
                initial.targetURI, initial.deviceIdBefore, device.updated ? device.deviceId : null, input.unrecoverableAt, 'unrecoverable');
            if (!effect) return invalidFileAvailability();
            const envelope = readPreparedUnrecoverable({ request: input, prepared: { version: 2, kind: 'project-file-unrecoverable',
                attachmentJSON: JSON.stringify(initial.attachment), targetURI: initial.targetURI,
                expectation: { kind: 'metadata-only' }, effect,
                result: { status: 'unrecoverable', message: deps.translate?.('attachments.unrecoverable') ?? 'attachments.unrecoverable', update: null } } });
            return envelope ? { ok: true, value: envelope } : invalidFileAvailability();
        },
        validatePreparedProjectFileAvailability(raw: unknown): NativeHostResult<NativeAttachmentResolution> {
            const envelope = readEnvelope(raw);
            return envelope ? { ok: true, value: envelope.prepared.result } : invalidFileAvailability();
        },
        async commitPreparedProjectFileAvailability(raw: unknown): Promise<NativeHostResult<NativeAttachmentResolution>> {
            const envelope = readEnvelope(raw); if (!envelope) return invalidFileAvailability();
            const ready = deps.readiness(); if (!ready.ok) return ready;
            if (!idle()) return savedFailure();
            const read = await readAreaDurableData(false, true); if (!read.ok) return read;
            const afterRead = deps.readiness(); if (!afterRead.ok) return afterRead;
            if (!idle() || !('concurrentWritesGuarded' in read.value.adapter) || read.value.adapter.concurrentWritesGuarded !== true)
                return savedFailure();
            const effect = envelope.prepared.effect;
            const applied = await useTaskStore.getState().commitPreparedProjectFileAvailability(effect, read.value.authority);
            if (!applied.success) return stale();
            if (applied.outcome !== 'replayed') {
                const saved = await saves.finish(effect, read.value.adapter, false, read.value.authority.saveBoundary);
                if (!saved.ok) return savedFailure();
            }
            if (getStorageAdapter() !== read.value.adapter || !idle()) return savedFailure();
            const after = await readAreaDurableData(false, true); if (!after.ok) return after;
            const finalReady = deps.readiness(); if (!finalReady.ok) return finalReady;
            const current = selectedProject(after.value.authority.snapshot.projects, effect.projectId);
            const live = useTaskStore.getState()._projectsById.get(effect.projectId);
            return after.value.adapter === read.value.adapter && current && live && projectFileAddLiveRowMatches(live, current)
                && sameProjectAvailabilityRawRow(current, effect.rawAfter)
                && (after.value.authority.snapshot.settings.deviceId ?? null) === (effect.deviceIdBefore ?? effect.deviceIdToInitialize)
                && idle() ? { ok: true, value: envelope.prepared.result } : savedFailure();
        },
    };
}
