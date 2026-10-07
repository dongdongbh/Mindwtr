import type { NativeHostResult } from './native-host-contract';
import { readNativeAttachments, type NativeAttachmentResolution, type NativeAttachmentsHost } from './native-host-contract-attachments';
import { readProjectAttachmentEditOptions, projectAttachmentWriteToken } from './native-host-contract-project-attachments';
import { readAreaDurableData, createAreaSaveGuard } from './native-host-contract-area-durable';
import { exact, record } from './native-host-contract-project-shared';
import { getAttachmentDownloadFileName } from './mobile-attachment-availability';
import { getStorageAdapter, getPersistenceStatus, useTaskStore } from './store';
import { rawReadProjectSnapshot, rawReadRow } from './sqlite-raw-snapshot';
import { projectToSqliteRow } from './project-sync-schema';
import { ensureDeviceId } from './store-helpers';
import { taskEditValuesEqual as same } from './json-value-equality';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { projectAvailabilityWritePlan, sameProjectAvailabilityRawRow, projectFileAddLiveRowMatches,
    projectFileAddScalarCellsMatchWriter } from './store-projects/project-actions';
import type { Project } from './types';

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

export function createProjectAvailabilityMethods(deps: Deps) {
    const saves = createAreaSaveGuard(deps.save);
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
        if (!before || !attachment || attachment.kind !== 'file' || attachment.deletedAt || !fileURI(attachment.uri)
            || typeof attachment.fileHash !== 'string' || !/^[0-9a-f]{64}$/i.test(attachment.fileHash)) return invalid();
        const targetURI = input.managedDirectoryURI + getAttachmentDownloadFileName(attachment);
        if (!fileURI(targetURI) || targetURI.slice(input.managedDirectoryURI.length).includes('/') || targetURI === attachment.uri)
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
            const device = ensureDeviceId(fresh.value.authority.snapshot.settings);
            const plan = projectAvailabilityWritePlan(initial.before, beforeCells, input.attachmentId, currentTargetURI,
                deviceIdBefore, device.updated ? device.deviceId : null, new Date().toISOString());
            if (!plan || !saves.mayApply(plan, fresh.value.adapter) || !idle()) return savedFailure();
            const applied = await useTaskStore.getState().commitSelectedProjectAvailability(plan, fresh.value.authority);
            if (!applied.success) return stale();
            const saved = await saves.finish(plan, fresh.value.adapter, false, fresh.value.authority.saveBoundary);
            if (!saved.ok) return savedFailure();
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
