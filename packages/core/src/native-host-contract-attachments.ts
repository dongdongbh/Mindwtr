/**
 * The native host contract for attachments: the task editor's Attachments field and the
 * project screen's Attachments card, as React Native's use-task-edit-attachments.ts and
 * use-project-attachments.ts run them. Kept in its own file and spread into
 * createNativeHostContract; every rule comes from attachment-editor-model.ts, the module
 * React Native's hooks call. The host does the platform IO (the pickers, opening a file or
 * a link, the share sheet, the image preview, the audio player) and binds `attachments`
 * (NativeAttachmentsHost) to core's mobile attachment modules over its file bridge.
 *
 * Owners. A task's attachments live in the editor's draft until Save, as in React Native:
 * every task command takes the draft's list (`owner.attachments`) and returns the next one,
 * writing nothing; saveTaskDraft's `attachments` half saves it (mergeTaskDraftAttachments),
 * and settleTaskDraftAttachments deletes the copies a discarded or replaced draft left
 * behind. A project's attachments are written at once, as React Native's project screen
 * writes them.
 *
 * - getAttachmentList: the rows (core's display title, Missing, Download, Loading; a
 *   project row's transfer progress) and whether the owner takes edits. Send the IDs of
 *   attachments with a Download or Open call in flight as `downloading`: their rows show
 *   Loading, as React Native's do while the download runs.
 * - addAttachmentFile: Add file and Add photo, with what the picker handed back. The new
 *   attachment's ID is the request UUID, so its managed copy (files/attachments/<id><ext>)
 *   is the same file on a retry and the attachment is added once.
 * - getAttachmentLinkCheck: the link sheet's line check while typing (Save stays off on an invalid line).
 * - submitAttachmentLinks: the link sheet's Save. Each link's ID derives from the request
 *   UUID (requestRowId), so a retry adds none twice. With `editing` (task only: the link's
 *   ID and its title and uri when the sheet opened), saves that link's new text,
 *   compare-and-set: a link that no longer holds those values is refused (STALE_REVISION).
 * - removeAttachment: a soft delete (sync removes the remote file); one already removed
 *   stays as it is.
 * - downloadAttachment and openAttachment: the bytes first, then (open) what to do with
 *   the attachment: `open` (AttachmentOpenPlan). A task answer carries `update`: apply it
 *   to the editor's draft as it is when the answer arrives with applyAttachmentUpdate,
 *   which drops it when the attachment changed meanwhile. A project's answer is already
 *   written. A missing file's download is marked `downloading` while it runs and restored
 *   to `missing` when it fails; a failed download never deletes local bytes.
 *
 * Crash safety (native-request-receipts.ts). Project writes run once per request UUID; on
 * the native host their receipt commits with the project, so a replay after a restart
 * answers from the first reply. Without a receipt each is target-state: an attachment the
 * request already added (by its ID) or removed is left alone. Downloads are idempotent: a
 * replay finds the bytes on disk, or downloads again. Replies carry IDs, never URIs, and
 * logs name a URI only by describeAttachmentUriForLog: a link can hold a password.
 *
 * Only functions read this module's imports from native-host-contract.ts, so the import
 * cycle between the two files is safe.
 */
import {
    addPickedAttachment,
    attachmentPatchChanges,
    findTaskDraftAttachmentForIdentity,
    getAttachmentLinkEditText,
    getAttachmentOpenLinkFailedMessage,
    getAttachmentResolutionMessage,
    getAttachmentRowState,
    logAttachmentWriteSkipped,
    patchAttachment,
    planAttachmentLinkBatch,
    planAttachmentLinkEdit,
    mergeTaskDraftAttachments,
    planAttachmentOpen,
    resolveAttachmentAvailability,
    softDeleteAttachment,
    type AttachmentAvailabilityPort,
    type AttachmentOpenPlan,
    type AttachmentResolution,
    type AttachmentRowState,
    describeAttachmentUriForLog,
} from './attachment-editor-model';
import { isAttachmentFileInUse, planAttachmentDraftSettlement } from './attachment-draft-settlement';
import { parseAttachmentLinkBatch } from './attachment-link-utils';
import { formatI18nTemplate, type TranslateFn } from './i18n';
import { globalProgressTracker } from './attachment-progress';
import { logWarn } from './logger';
import {
    getAttachmentAvailabilityPatch,
    getAttachmentDownloadIdentity,
    getAttachmentUnrecoverablePatch,
    hasAttachmentDownloadIdentity,
    type AttachmentAvailabilityOutcome,
} from './mobile-attachment-availability';
import type { NativeHostResult } from './native-host-contract';
import { fail, isObjectRecord, isText } from './native-host-contract-menu-views';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { createNativeRequestReceipts, requestRowId, runStoreWrite, settleWrite, taskRevisionOf } from './native-request-receipts';
import { useTaskStore } from './store';
import type { Attachment, Project, Task } from './types';
import { taskEditValuesEqual } from './json-value-equality';
import { isStatusListTaskReadOnly } from './menu-views-model';

/** Core's mobile attachment modules, bound by the host to its file bridge. */
export type NativeAttachmentsHost = {
    /** createMobileAttachmentFiles(...).persistAttachmentLocally: copies a picked file into files/attachments/. */
    persistAttachmentLocally(attachment: Attachment): Promise<Attachment>;
    /** createMobileAttachmentAvailability(...).ensureAttachmentAvailableDetailed: the on-demand download. */
    ensureAttachmentAvailableDetailed(attachment: Attachment): Promise<AttachmentAvailabilityOutcome>;
    /**
     * createMobileAttachmentFiles(...).deleteManagedAttachmentFile: removes a managed copy, never
     * another file. Call `keep` after every await, immediately before the delete; true keeps it.
     */
    deleteManagedAttachmentFile(attachment: Attachment, options?: { keep?: () => boolean }): Promise<unknown>;
};

/** Whose attachments: the task editor's draft list, or a project's stored list. */
export type NativeAttachmentOwner =
    | { kind: 'task'; taskId: string; attachments: Attachment[] }
    | { kind: 'project'; projectId: string };

/** What a picker handed back. */
export type NativePickedAttachment = { uri: string; name: string | null; mimeType: string | null; size: number | null };

export type NativeAttachmentRow = AttachmentRowState & {
    /** Canonical captured download identity; display-only and null for links. */
    readonly downloadIdentity: string | null;
    /** A task's link: the pencil opens the link sheet on this text; null for any other row. */
    editText: string | null;
    /** A project row's transfer bar: null hides it; `percentage` null shows the bar empty with "...". */
    progress: { percentage: number | null } | null;
};

export type NativeAttachmentList = { rows: NativeAttachmentRow[]; canEdit: boolean };

/** A task command's answer carries the draft's next list; a project's was written. */
export type NativeAttachmentChange =
    /** Show `message` under the Attachments title; nothing changed (keep the link sheet open). */
    | { kind: 'refused'; message: string }
    /** An archived or deleted project: nothing happens, as in React Native. */
    | { kind: 'blocked' }
    /** Blank link text: mark the field touched. */
    | { kind: 'empty' }
    /** Link text with no line: nothing happens. */
    | { kind: 'nothing' }
    /** Done (close the link sheet). `attachments`: the task draft's next list; null for a project. */
    | { kind: 'saved'; ids: string[]; attachments: Attachment[] | null };

export type NativeAttachmentUpdate = { attachmentId: string; identity: string; patch: Partial<Attachment> };

export type NativeAttachmentResolution = {
    status: AttachmentResolution['status'];
    /** Show under the Attachments title; null shows nothing. */
    message: string | null;
    /** A task download's change to the draft: applyAttachmentUpdate. Null for a project (written) or no change. */
    update: NativeAttachmentUpdate | null;
};

export type NativeAttachmentOpen = NativeAttachmentResolution & {
    /** What to do once the bytes are there; null when `status` is not `available`. */
    open: (AttachmentOpenPlan & { failedMessage?: string }) | null;
};

type AttachmentDeps = {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    t: () => TranslateFn;
    requestIdPattern: RegExp;
    isReadOnly: (task: Task) => boolean;
    host: () => NativeAttachmentsHost | null;
};

const LIST_LIMIT = 1_000;
const TEXT_LIMIT = 100_000;
const ID_LIMIT = 500;
const STAMP = (value: unknown) => isText(value, 100) && Boolean(value);
const ATTACHMENT_KEYS = new Set(['id', 'kind', 'title', 'uri', 'mimeType', 'size', 'createdAt', 'updatedAt',
    'deletedAt', 'cloudKey', 'fileHash', 'contentRev', 'contentMtimeMs', 'contentSize', 'pendingContentUpload', 'localStatus']);
const LOCAL_STATUSES = new Set(['available', 'missing', 'uploading', 'downloading']);

const isAttachment = (value: unknown): value is Attachment => isObjectRecord(value)
    && Object.keys(value).every((key) => ATTACHMENT_KEYS.has(key))
    && isText(value.id, ID_LIMIT) && Boolean(value.id) && (value.kind === 'file' || value.kind === 'link')
    && isText(value.title, TEXT_LIMIT) && isText(value.uri, TEXT_LIMIT) && STAMP(value.createdAt) && STAMP(value.updatedAt)
    && ['mimeType', 'deletedAt', 'cloudKey', 'fileHash'].every((key) => value[key] === undefined || isText(value[key], TEXT_LIMIT))
    && ['size', 'contentRev', 'contentMtimeMs', 'contentSize'].every((key) => value[key] === undefined
        || (typeof value[key] === 'number' && Number.isFinite(value[key])))
    && (value.pendingContentUpload === undefined || typeof value.pendingContentUpload === 'boolean')
    && (value.localStatus === undefined || LOCAL_STATUSES.has(String(value.localStatus)));

/** A bounded list of attachment records, as the store keeps them; null when it is not one. */
export const readNativeAttachments = (value: unknown): Attachment[] | null => (
    Array.isArray(value) && value.length <= LIST_LIMIT && value.every(isAttachment)
        && new Set(value.map((attachment) => attachment.id)).size === value.length && isNativeJsonWithinBytes(value)
        ? JSON.parse(JSON.stringify(value)) as Attachment[]
        : null
);

export type NativeTaskLinkHalf = { base: Attachment[]; value: Attachment[] };
const ISO = (value: string): boolean => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const same = taskEditValuesEqual;
const linkTextValid = (attachment: Attachment): boolean => {
    if (attachment.kind !== 'link' || /[\r\n]/.test(attachment.uri)) return false;
    const parsed = parseAttachmentLinkBatch(attachment.uri);
    return parsed.invalidLine === null && parsed.entries.length === 1 && parsed.entries[0].uri === attachment.uri
        && (attachment.title === attachment.title.trim().replace(/\s+/g, ' ')
            || attachment.title === parsed.entries[0].title);
};

/** The iOS prepared editor owns only URL edits. Keep every old record, including tombstones. */
export const readNativeTaskLinkHalf = (input: unknown, requireChanged = true): NativeTaskLinkHalf | null => {
    if (!isObjectRecord(input) || Object.keys(input).length !== 2 || !('base' in input) || !('value' in input)) return null;
    const base = readNativeAttachments(input.base), value = readNativeAttachments(input.value);
    if (!base || !value) return null;
    const byId = new Map(value.map((attachment) => [attachment.id, attachment]));
    if (base.some((before) => !byId.has(before.id))) return null;
    const old = new Map(base.map((attachment) => [attachment.id, attachment]));
    let changed = false;
    for (const after of value) {
        const before = old.get(after.id);
        if (!before) {
            if (after.kind !== 'link' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(after.id)
                || Object.keys(after).some((key) => !['id', 'kind', 'title', 'uri', 'createdAt', 'updatedAt', 'deletedAt'].includes(key))
                || !ISO(after.createdAt) || !ISO(after.updatedAt)
                || (after.deletedAt !== undefined && !ISO(after.deletedAt)) || !linkTextValid(after)) return null;
            changed = true;
        } else if (!same(before, after)) {
            if (before.kind !== 'link' || after.kind !== 'link' || before.deletedAt
                || ((before.title !== after.title || before.uri !== after.uri) && !linkTextValid(after))
                || !ISO(after.updatedAt)
                || Object.keys({ ...before, ...after }).some((key) => !['title', 'uri', 'updatedAt', 'deletedAt'].includes(key)
                    && !same(before[key as keyof Attachment], after[key as keyof Attachment]))
                || (after.deletedAt !== undefined && (!ISO(after.deletedAt) || before.deletedAt !== undefined))
                || (after.title === before.title && after.uri === before.uri && after.deletedAt === before.deletedAt)) return null;
            changed = true;
        }
    }
    return changed || !requireChanged ? { base, value } : null;
};

/** Merge local URL edits onto latest saved rows, refusing even a forged base for a live file. */
export const mergeNativeTaskLinkHalf = (stored: readonly Attachment[], half: NativeTaskLinkHalf): Attachment[] | null => {
    const before = new Map(half.base.map((attachment) => [attachment.id, attachment]));
    const value = new Map(half.value.map((attachment) => [attachment.id, attachment]));
    if (stored.some((attachment) => attachment.kind === 'file' && before.get(attachment.id)?.kind === 'link'
        || !before.has(attachment.id) && value.has(attachment.id))) return null;
    const merged = mergeTaskDraftAttachments(stored, half.base, half.value);
    if (stored.some((attachment) => attachment.kind === 'file'
        && !same(attachment, merged.find((row) => row.id === attachment.id)))) return null;
    return readNativeAttachments(merged);
};

const readOwner = (value: unknown): NativeAttachmentOwner | null => {
    if (!isObjectRecord(value)) return null;
    if (value.kind === 'project') {
        return isText(value.projectId, ID_LIMIT) && Boolean(value.projectId) && Object.keys(value).length === 2
            ? { kind: 'project', projectId: value.projectId }
            : null;
    }
    if (value.kind !== 'task' || !isText(value.taskId, ID_LIMIT) || !value.taskId || Object.keys(value).length !== 3) return null;
    const attachments = readNativeAttachments(value.attachments);
    return attachments ? { kind: 'task', taskId: value.taskId, attachments } : null;
};

const readPicked = (value: unknown): NativePickedAttachment | null => (
    isObjectRecord(value) && Object.keys(value).length === 4
        && isText(value.uri, TEXT_LIMIT) && Boolean(value.uri)
        && (value.name === null || isText(value.name, TEXT_LIMIT))
        && (value.mimeType === null || isText(value.mimeType, 500))
        && (value.size === null || (typeof value.size === 'number' && Number.isFinite(value.size) && value.size >= 0))
        ? value as NativePickedAttachment
        : null
);

const availabilityOf = (host: NativeAttachmentsHost): AttachmentAvailabilityPort => ({
    ensureAttachmentAvailableDetailed: (attachment) => host.ensureAttachmentAvailableDetailed(attachment),
    getAttachmentDownloadIdentity,
    hasAttachmentDownloadIdentity,
    getAttachmentAvailabilityPatch,
    getAttachmentUnrecoverablePatch,
});

const progressOf = (attachmentId: string): NativeAttachmentRow['progress'] => {
    const progress = globalProgressTracker.getProgress(attachmentId);
    if (!progress || progress.status === 'completed' || progress.status === 'failed') return null;
    const total = progress.totalBytes;
    return { percentage: total > 0 ? Math.min(100, Math.round((progress.bytesTransferred / total) * 100)) : null };
};

/** A task draft's attachment `update`, applied while that attachment still has `identity`. */
export const applyNativeAttachmentUpdate = (attachments: readonly Attachment[], update: NativeAttachmentUpdate): Attachment[] => {
    const current = attachments.find((attachment) => attachment.id === update.attachmentId);
    return hasAttachmentDownloadIdentity(current, update.identity)
        ? patchAttachment(attachments, update.attachmentId, update.patch)
        : [...attachments];
};

export function createAttachmentMethods(deps: AttachmentDeps) {
    const receipts = createNativeRequestReceipts({
        save: async () => {
            if (useTaskStore.getState().persistenceFailure) {
                try {
                    await useTaskStore.getState().retryPersistence();
                } catch (error) {
                    return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error));
                }
            }
            return deps.save();
        },
    });
    const unbound = (): NativeHostResult<never> => fail('ACTION_FAILED', 'Attachments are not available on this host');
    const ownerError = (): NativeHostResult<never> => fail('INVALID_INPUT', 'A task owner (its ID and the editor\'s attachment list) or a project owner (its ID) is required');
    const mutableTask = (owner: NativeAttachmentOwner): boolean => {
        if (owner.kind !== 'task') return false;
        const state = useTaskStore.getState();
        const task = state._tasksById.get(owner.taskId);
        return Boolean(task && !task.deletedAt && !task.purgedAt
            && !deps.isReadOnly(task) && !isStatusListTaskReadOnly(task, state._allProjects));
    };
    const storedProject = (projectId: string): Project | undefined => useTaskStore.getState()._allProjects
        .find((project) => project.id === projectId && !project.deletedAt && !project.purgedAt);
    const mutableProject = (projectId: string): Project | null => {
        const project = storedProject(projectId);
        return project && project.status !== 'archived' ? project : null;
    };
    /** A project download's availability fields were written to the store: save them. */
    const saveProjectWrites = async (owner: NativeAttachmentOwner): Promise<NativeHostResult<null>> => {
        if (owner.kind !== 'project') return { ok: true, value: null };
        if (useTaskStore.getState().persistenceFailure) {
            try {
                await useTaskStore.getState().retryPersistence();
            } catch (error) {
                return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error));
            }
        }
        return deps.save();
    };
    const writeProject = async (projectId: string, attachments: Attachment[], ids: string[]) => {
        const written = await runStoreWrite(() => useTaskStore.getState().updateProject(projectId, { attachments }));
        return settleWrite<NativeAttachmentChange>(written, { kind: 'saved', ids, attachments: null });
    };

    /**
     * Download and Open's first half, as React Native resolves an attachment: a task's
     * changes go to a copy of the draft (returned as `update`), a project's to the store.
     */
    const resolve = async (owner: NativeAttachmentOwner, attachmentId: string, host: NativeAttachmentsHost) => {
        const availability = availabilityOf(host);
        if (owner.kind === 'task') {
            let draft = owner.attachments;
            const attachment = draft.find((item) => item.id === attachmentId && !item.deletedAt);
            if (!attachment) return null;
            let patch: Partial<Attachment> = {};
            const current = (id: string, identity: string) => findTaskDraftAttachmentForIdentity({
                draft,
                stored: () => useTaskStore.getState()._allTasks.find((task) => task.id === owner.taskId)
                    ?.attachments?.find((item) => item.id === id),
                attachmentId: id,
                identity,
                has: hasAttachmentDownloadIdentity,
            });
            const resolution = await resolveAttachmentAvailability(attachment, {
                availability,
                current,
                update: (id, identity, next) => {
                    const found = current(id, identity);
                    if (!found) return null;
                    patch = { ...patch, ...next };
                    draft = patchAttachment(draft, id, next);
                    return { ...found, ...next };
                },
            });
            const identity = getAttachmentDownloadIdentity(attachment);
            const changed = Object.keys(patch).some((key) => attachment[key as keyof Attachment] !== patch[key as keyof Attachment]);
            return { resolution, update: changed ? { attachmentId, identity, patch } : null };
        }
        const project = storedProject(owner.projectId);
        const attachment = project?.attachments?.find((item) => item.id === attachmentId && !item.deletedAt);
        if (!project || !attachment) return null;
        const current = (id: string, identity: string) => {
            const found = storedProject(owner.projectId)?.attachments?.find((item) => item.id === id);
            return hasAttachmentDownloadIdentity(found, identity) ? found : null;
        };
        const resolution = await resolveAttachmentAvailability(attachment, {
            availability,
            current,
            update: (id, identity, next) => {
                const found = current(id, identity);
                const latest = storedProject(owner.projectId);
                if (!found || !latest) return null;
                if (!attachmentPatchChanges(found, next)) {
                    logAttachmentWriteSkipped();
                    return { ...found, ...next };
                }
                void useTaskStore.getState().updateProject(owner.projectId, { attachments: patchAttachment(latest.attachments ?? [], id, next) });
                return { ...found, ...next };
            },
        });
        return { resolution, update: null };
    };

    return {
        /** The owner's attachment rows (removed ones hidden) and whether it takes edits. */
        getAttachmentList(input: { owner: NativeAttachmentOwner; downloading?: string[] }): NativeHostResult<NativeAttachmentList> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input)) return ownerError();
            const owner = readOwner(input.owner);
            if (!owner) return ownerError();
            const downloading = input.downloading ?? [];
            if (!Array.isArray(downloading) || downloading.length > LIST_LIMIT || !downloading.every((id) => isText(id, ID_LIMIT))) {
                return fail('INVALID_INPUT', 'downloading must list attachment IDs');
            }
            let attachments: Attachment[];
            let canEdit: boolean;
            if (owner.kind === 'task') {
                const task = useTaskStore.getState()._tasksById.get(owner.taskId);
                if (!task || task.deletedAt) return fail('TASK_NOT_FOUND', 'Task not found');
                attachments = owner.attachments;
                canEdit = mutableTask(owner);
            } else {
                const project = storedProject(owner.projectId);
                if (!project) return fail('STALE_REVISION', 'Project is unavailable; read the projects again');
                attachments = project.attachments ?? [];
                canEdit = project.status !== 'archived';
            }
            const inFlight = new Set(downloading);
            const rows = attachments.filter((attachment) => !attachment.deletedAt).map((attachment): NativeAttachmentRow => {
                const row = getAttachmentRowState(inFlight.has(attachment.id) ? { ...attachment, localStatus: 'downloading' } : attachment);
                return {
                    ...row,
                    downloadIdentity: attachment.kind === 'file' ? getAttachmentDownloadIdentity(attachment) : null,
                    editText: owner.kind === 'task' && attachment.kind === 'link' ? getAttachmentLinkEditText(attachment) : null,
                    progress: owner.kind === 'project' ? progressOf(attachment.id) : null,
                };
            });
            const value = { rows, canEdit };
            return isNativeJsonWithinBytes(value) ? { ok: true, value } : fail('INVALID_INPUT', 'The attachment list exceeds the bounded native response');
        },

        /**
         * The link sheet's line check while typing, as React Native's sheets show it under the field: the first line that is
         * not a link, and Save stays off while there is one. The edit sheet (`editing`) takes one line and shows none.
         */
        getAttachmentLinkCheck(input: { text: string; editing?: boolean }): NativeHostResult<{ error: string | null }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !isText(input.text, TEXT_LIMIT) || (input.editing !== undefined && typeof input.editing !== 'boolean')) {
                return fail('INVALID_INPUT', 'The link text is required');
            }
            const invalidLine = input.editing ? null : parseAttachmentLinkBatch(input.text).invalidLine;
            return { ok: true, value: { error: invalidLine === null ? null : formatI18nTemplate(deps.t()('attachments.invalidLinkLine'), { line: invalidLine }) } };
        },

        /** Add file (`file`) or Add photo (`image`): the picked file is validated and copied into files/attachments/. */
        async addAttachmentFile(input: {
            requestId: string;
            owner: NativeAttachmentOwner;
            source: 'file' | 'image';
            picked: NativePickedAttachment;
        }): Promise<NativeHostResult<NativeAttachmentChange>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId)
                || (input.source !== 'file' && input.source !== 'image')) {
                return fail('INVALID_INPUT', 'A request UUID and a source (file or image) are required');
            }
            const owner = readOwner(input.owner);
            if (!owner) return ownerError();
            const picked = readPicked(input.picked);
            if (!picked) return fail('INVALID_INPUT', 'picked needs the file\'s uri, name, mimeType and size (null when unknown)');
            const host = deps.host();
            if (!host) return unbound();
            const id = input.requestId.toLowerCase();
            const { source } = input;
            const add = () => addPickedAttachment({
                source,
                asset: source === 'file'
                    ? { uri: picked.uri, name: picked.name, mimeType: picked.mimeType, size: picked.size }
                    : { uri: picked.uri, fileName: picked.name, mimeType: picked.mimeType, fileSize: picked.size },
                newId: () => id,
                persist: async (attachment) => {
                    try {
                        return await host.persistAttachmentLocally(attachment);
                    } catch (error) {
                        logWarn('Native attachment copy failed', {
                            scope: 'attachment',
                            context: { id: attachment.id, uri: describeAttachmentUriForLog(attachment.uri), error: error instanceof Error ? error.name : 'unknown' },
                        });
                        return attachment;
                    }
                },
                t: deps.t(),
            });
            if (owner.kind === 'task') {
                if (owner.attachments.some((attachment) => attachment.id === id)) {
                    return { ok: true, value: { kind: 'saved', ids: [id], attachments: owner.attachments } };
                }
                const outcome = await add();
                return outcome.kind === 'refused'
                    ? { ok: true, value: outcome }
                    : { ok: true, value: { kind: 'saved', ids: [id], attachments: [...owner.attachments, outcome.attachment] } };
            }
            return receipts.run<NativeAttachmentChange>(id, JSON.stringify(['attachmentAddFile', owner.projectId, source, picked]), async () => {
                if (storedProject(owner.projectId)?.attachments?.some((attachment) => attachment.id === id)) {
                    return { ok: true, value: { kind: 'saved', ids: [id], attachments: null } };
                }
                if (!mutableProject(owner.projectId)) return { ok: true, value: { kind: 'blocked' } };
                const outcome = await add();
                if (outcome.kind === 'refused') return { ok: true, value: outcome };
                // As React Native checks again after the copy: the project may have been archived meanwhile.
                const project = mutableProject(owner.projectId);
                if (!project) return { ok: true, value: { kind: 'blocked' } };
                return writeProject(project.id, [...(project.attachments ?? []), outcome.attachment], [id]);
            });
        },

        /** The link sheet's Save: new links, one per line, or (task) the edited link. */
        async submitAttachmentLinks(input: {
            requestId: string;
            owner: NativeAttachmentOwner;
            text: string;
            editing?: { attachmentId: string; title: string; uri: string } | null;
            urlOnly?: boolean;
        }): Promise<NativeHostResult<NativeAttachmentChange>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId)
                || !isText(input.text, TEXT_LIMIT)) {
                return fail('INVALID_INPUT', 'A request UUID and the link text are required');
            }
            const owner = readOwner(input.owner);
            if (!owner) return ownerError();
            if (input.urlOnly && !mutableTask(owner)) return fail('INVALID_INPUT', 'Task cannot edit links');
            const editing = input.editing ?? null;
            if (editing !== null && (owner.kind !== 'task' || !isObjectRecord(editing) || !isText(editing.attachmentId, ID_LIMIT)
                || !isText(editing.title, TEXT_LIMIT) || !isText(editing.uri, TEXT_LIMIT)
                || owner.attachments.find((attachment) => attachment.id === editing.attachmentId)?.kind !== 'link')) {
                return fail('INVALID_INPUT', 'Only a task draft\'s link can be edited, with its ID, title and uri when the sheet opened');
            }
            if (input.urlOnly && editing && owner.kind === 'task'
                && useTaskStore.getState()._tasksById.get(owner.taskId)?.attachments
                    ?.some((attachment) => attachment.id === editing.attachmentId && attachment.kind === 'file'))
                return fail('INVALID_INPUT', 'Only a link can be edited');
            const t = deps.t();
            const now = new Date().toISOString();
            const requestId = input.requestId.toLowerCase();
            let index = 0;
            const newId = () => requestRowId(requestId, `link:${index++}`);
            if (owner.kind === 'task') {
                if (!input.text.trim()) return { ok: true, value: { kind: 'empty' } };
                if (editing !== null) {
                    const edit = planAttachmentLinkEdit(input.text, now, t);
                    if (edit.kind === 'refused') return { ok: true, value: edit };
                    const before = owner.attachments.find((attachment) => attachment.id === editing.attachmentId)!;
                    // Compare-and-set: a retry whose link already holds the text changes nothing; a
                    // link changed since the sheet opened (a later edit) is never undone.
                    if (before.title === edit.patch.title && before.uri === edit.patch.uri) {
                        return { ok: true, value: { kind: 'saved', ids: [before.id], attachments: owner.attachments } };
                    }
                    if (before.title !== editing.title || before.uri !== editing.uri) {
                        return fail('STALE_REVISION', 'The link changed since the sheet opened; read the list again');
                    }
                    return { ok: true, value: { kind: 'saved', ids: [before.id], attachments: patchAttachment(owner.attachments, before.id, edit.patch) } };
                }
                const batch = planAttachmentLinkBatch(input.text, { newId, now, t });
                if (batch.kind !== 'add') return { ok: true, value: batch };
                const ids = batch.added.map((attachment) => attachment.id);
                const known = new Set(owner.attachments.map((attachment) => attachment.id));
                return { ok: true, value: { kind: 'saved', ids, attachments: ids.some((id) => known.has(id))
                    ? owner.attachments
                    : [...owner.attachments, ...batch.added] } };
            }
            const batch = planAttachmentLinkBatch(input.text, { newId, now, t });
            const ids = batch.kind === 'add' ? batch.added.map((attachment) => attachment.id) : [];
            // Inside the receipt, so a retry answers its first reply even once the project is archived.
            return receipts.run<NativeAttachmentChange>(requestId, JSON.stringify(['attachmentLinks', owner.projectId, input.text]), async () => {
                if (storedProject(owner.projectId)?.attachments?.some((attachment) => ids.includes(attachment.id))) {
                    return { ok: true, value: { kind: 'saved', ids, attachments: null } };
                }
                // As React Native's project screen: an archived project takes no link, and asks nothing.
                const project = mutableProject(owner.projectId);
                if (!project) return { ok: true, value: { kind: 'blocked' } };
                if (batch.kind !== 'add') return { ok: true, value: batch };
                return writeProject(project.id, [...(project.attachments ?? []), ...batch.added], ids);
            });
        },

        /** Remove: a soft delete. Reuse `requestId` to retry a project's. */
        async removeAttachment(input: { requestId: string; owner: NativeAttachmentOwner; attachmentId: string; urlOnly?: boolean }): Promise<NativeHostResult<NativeAttachmentChange>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId)
                || !isText(input.attachmentId, ID_LIMIT) || !input.attachmentId) {
                return fail('INVALID_INPUT', 'A request UUID and an attachment ID are required');
            }
            const owner = readOwner(input.owner);
            if (!owner) return ownerError();
            const { attachmentId } = input;
            const now = new Date().toISOString();
            if (input.urlOnly && (!mutableTask(owner) || owner.kind !== 'task'
                || owner.attachments.find((attachment) => attachment.id === attachmentId)?.kind !== 'link'
                || useTaskStore.getState()._tasksById.get(owner.taskId)?.attachments
                    ?.some((attachment) => attachment.id === attachmentId && attachment.kind === 'file')))
                return fail('INVALID_INPUT', 'Only a link can be removed');
            if (owner.kind === 'task') {
                const target = owner.attachments.find((attachment) => attachment.id === attachmentId);
                return { ok: true, value: { kind: 'saved', ids: [attachmentId], attachments: !target || target.deletedAt
                    ? owner.attachments
                    : softDeleteAttachment(owner.attachments, attachmentId, now) } };
            }
            return receipts.run<NativeAttachmentChange>(input.requestId, JSON.stringify(['attachmentRemove', owner.projectId, attachmentId]), async () => {
                const project = mutableProject(owner.projectId);
                if (!project) return { ok: true, value: { kind: 'blocked' } };
                const target = project.attachments?.find((attachment) => attachment.id === attachmentId);
                if (!target || target.deletedAt) return { ok: true, value: { kind: 'saved', ids: [attachmentId], attachments: null } };
                return writeProject(project.id, softDeleteAttachment(project.attachments ?? [], attachmentId, now), [attachmentId]);
            });
        },

        /** Download, and its retry: fetches a synced file's bytes. */
        async downloadAttachment(input: { owner: NativeAttachmentOwner; attachmentId: string }): Promise<NativeHostResult<NativeAttachmentResolution>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !isText(input.attachmentId, ID_LIMIT) || !input.attachmentId) return fail('INVALID_INPUT', 'An attachment ID is required');
            const owner = readOwner(input.owner);
            if (!owner) return ownerError();
            const host = deps.host();
            if (!host) return unbound();
            const resolved = await resolve(owner, input.attachmentId, host);
            if (!resolved) return fail('STALE_REVISION', 'The attachment is gone; read the list again');
            const saved = await saveProjectWrites(owner);
            if (!saved.ok) return saved;
            return { ok: true, value: {
                status: resolved.resolution.status,
                message: getAttachmentResolutionMessage(resolved.resolution, deps.t()),
                update: resolved.update,
            } };
        },

        /** Open: the bytes first (downloading a synced file), then what to open. */
        async openAttachment(input: { owner: NativeAttachmentOwner; attachmentId: string; urlOnly?: boolean }): Promise<NativeHostResult<NativeAttachmentOpen>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!isObjectRecord(input) || !isText(input.attachmentId, ID_LIMIT) || !input.attachmentId) return fail('INVALID_INPUT', 'An attachment ID is required');
            const owner = readOwner(input.owner);
            if (!owner) return ownerError();
            if (input.urlOnly) {
                let attachment: Attachment | undefined;
                if (owner.kind === 'task') {
                    const task = useTaskStore.getState()._tasksById.get(owner.taskId);
                    if (!task || task.deletedAt || task.purgedAt) return fail('INVALID_INPUT', 'Task cannot open links');
                    attachment = owner.attachments.find((item) => item.id === input.attachmentId && !item.deletedAt);
                    if (attachment?.kind !== 'link' || task.attachments
                        ?.some((item) => item.id === input.attachmentId && item.kind === 'file')) {
                        return fail('INVALID_INPUT', 'Only a task link can be opened');
                    }
                } else {
                    const project = storedProject(owner.projectId);
                    if (!project) return fail('STALE_REVISION', 'Project is unavailable; read the projects again');
                    attachment = project.attachments?.find((item) => item.id === input.attachmentId && !item.deletedAt);
                    if (attachment?.kind !== 'link') return fail('INVALID_INPUT', 'Only a project link can be opened');
                }
                const t = deps.t();
                const plan = planAttachmentOpen(attachment, { audio: owner.kind === 'task', t });
                return { ok: true, value: {
                    status: 'available', message: null, update: null,
                    open: plan.kind === 'link' ? { ...plan, failedMessage: getAttachmentOpenLinkFailedMessage(t) } : plan,
                } };
            }
            const host = deps.host();
            if (!host) return unbound();
            const resolved = await resolve(owner, input.attachmentId, host);
            if (!resolved) return fail('STALE_REVISION', 'The attachment is gone; read the list again');
            const saved = await saveProjectWrites(owner);
            if (!saved.ok) return saved;
            const t = deps.t();
            const { resolution } = resolved;
            const plan = resolution.status === 'available' ? planAttachmentOpen(resolution.attachment, { audio: owner.kind === 'task', t }) : null;
            return { ok: true, value: {
                status: resolution.status,
                message: getAttachmentResolutionMessage(resolution, t),
                update: resolved.update,
                open: plan?.kind === 'link' ? { ...plan, failedMessage: getAttachmentOpenLinkFailedMessage(t) } : plan,
            } };
        },

        /** A task download's answer applied to the editor's draft as it is now. */
        applyAttachmentUpdate(input: { attachments: Attachment[]; update: NativeAttachmentUpdate }): NativeHostResult<Attachment[]> {
            if (!isObjectRecord(input) || !isObjectRecord(input.update) || !isText(input.update.attachmentId, ID_LIMIT)
                || !isText(input.update.identity, TEXT_LIMIT) || !isObjectRecord(input.update.patch)) {
                return fail('INVALID_INPUT', 'The draft\'s attachments and a download update are required');
            }
            const attachments = readNativeAttachments(input.attachments);
            if (!attachments) return fail('INVALID_INPUT', 'attachments must be a bounded attachment list');
            const next = applyNativeAttachmentUpdate(attachments, input.update as NativeAttachmentUpdate);
            return readNativeAttachments(next) ? { ok: true, value: next } : fail('INVALID_INPUT', 'The update does not fit an attachment');
        },

        /**
         * After the editor's Save (`committed`: the saved task's attachments) or Discard
         * (`committed`: `baseline`): deletes the managed copies no attachment owns any more,
         * as React Native's editor settles its draft. `taskRevision` is the task's as
         * getTaskView showed it after the Save (or at the Discard). The bytes are checked
         * against the store as it is now: a file any live task or project attachment still
         * points to is kept (an attachment restored before the cleanup ran), and a removed or
         * replaced saved file is kept once the task changed after `taskRevision`. A kept copy
         * no record owns is left for the orphan cleanup.
         */
        async settleTaskDraftAttachments(input: {
            taskId: string;
            taskRevision: string;
            baseline: Attachment[];
            draft: Attachment[];
            committed: Attachment[];
        }): Promise<NativeHostResult<{ deleted: number }>> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const lists = isObjectRecord(input) && isText(input.taskId, ID_LIMIT) && isText(input.taskRevision, TEXT_LIMIT)
                ? [input.baseline, input.draft, input.committed].map(readNativeAttachments)
                : [];
            if (lists.length !== 3 || lists.some((list) => !list)) {
                return fail('INVALID_INPUT', 'The task ID, its revision, and the baseline, draft and committed attachment lists are required');
            }
            const host = deps.host();
            if (!host) return unbound();
            const [baselineAttachments, draftAttachments, committedAttachments] = lists as Attachment[][];
            const candidates = planAttachmentDraftSettlement({ baselineAttachments, draftAttachments, committedAttachments });
            let deleted = 0;
            for (const { attachment, reason } of candidates) {
                // Asked by the host after its own awaits, immediately before the delete.
                const keep = () => {
                    const state = useTaskStore.getState();
                    const task = state._tasksById.get(input.taskId);
                    const moved = !task || taskRevisionOf(task) !== input.taskRevision;
                    return isAttachmentFileInUse(attachment.uri, [...state._allTasks, ...state._allProjects])
                        || (moved && reason !== 'uncommitted-draft');
                };
                if (keep()) continue;
                try {
                    if (await host.deleteManagedAttachmentFile(attachment, { keep }) !== false) deleted += 1;
                } catch (error) {
                    logWarn('Native draft attachment cleanup failed', {
                        scope: 'attachment',
                        context: { id: attachment.id, uri: describeAttachmentUriForLog(attachment.uri), error: error instanceof Error ? error.name : 'unknown' },
                    });
                }
            }
            return { ok: true, value: { deleted } };
        },
    };
}
