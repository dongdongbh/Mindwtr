// The attachment field of the task editor and the project screen: what React Native's
// `use-task-edit-attachments.ts` and `use-project-attachments.ts` decide, moved here so the
// native apps run the same rules. A screen keeps its own state (the editor's draft, the
// selected project) and does the platform IO (pickers, Alert, opening a file); every rule
// here takes that state and IO through arguments, and never reads the store.
import type { Attachment, Project } from './types';
import type { AttachmentAvailabilityOutcome } from './mobile-attachment-availability';
import { getAttachmentDisplayTitle, normalizeLinkAttachmentInput, parseAttachmentLinkBatch } from './attachment-link-utils';
import { validateAttachmentForUpload } from './attachment-validation';
import { formatI18nTemplate, tFallback } from './i18n';
import { isLikelyFilePath } from './mobile-sync-utils';
import { isImageAttachment } from './task-view-model';
import { taskEditValuesEqual } from './json-value-equality';
import { logInfo } from './logger';

type Translate = (key: string) => string;

/** What a picker hands back: expo-document-picker's `name`/`size`, expo-image-picker's `fileName`/`fileSize`. */
export type PickedAttachmentAsset = {
    uri: string;
    name?: string | null;
    fileName?: string | null;
    mimeType?: string | null;
    size?: number | null;
    fileSize?: number | null;
};

/** The pick's outcome: `refused` shows `message` under the Attachments title and adds nothing. */
export type PickedAttachmentOutcome =
    | { kind: 'refused'; message: string }
    | { kind: 'added'; attachment: Attachment };

/** Complete pick metadata before persistence. Callers retain their own immutable copy;
 * this preparation is not proof of durable ownership or of a successful file copy. */
export type PreparedPickedAttachment = {
    kind: 'prepared';
    attachment: Readonly<Attachment>;
};
export type PickedAttachmentPreparation =
    | { kind: 'refused'; message: string }
    | PreparedPickedAttachment;

/** A screen's download or open: the availability outcome, or `stale` when the screen moved on. */
export type AttachmentResolution = AttachmentAvailabilityOutcome | { status: 'stale' };

/** The on-demand download and the rules that keep its result to the attachment it started on. */
export type AttachmentAvailabilityPort = {
    ensureAttachmentAvailableDetailed(attachment: Attachment): Promise<AttachmentAvailabilityOutcome>;
    getAttachmentDownloadIdentity(attachment: Attachment): string;
    hasAttachmentDownloadIdentity(attachment: Attachment | undefined, identity: string): attachment is Attachment;
    getAttachmentAvailabilityPatch(current: Attachment, resolved: Attachment): Partial<Attachment>;
    getAttachmentUnrecoverablePatch(resolved: Attachment): Partial<Attachment>;
};

/** What opening a resolved attachment does. */
export type AttachmentOpenPlan =
    /** Show `message` under the Attachments title: a link to a file on another device (#1001). */
    | { kind: 'alert'; message: string }
    /** A link: open it; a failure shows getAttachmentOpenLinkFailedMessage. */
    | { kind: 'link'; uri: string }
    /** The task editor's audio player. */
    | { kind: 'audio'; attachment: Attachment }
    /** The image preview. */
    | { kind: 'image'; attachment: Attachment }
    /** A file: Android's viewer (ACTION_VIEW with `viewMimeType`), else the share sheet, else open the URI. */
    | { kind: 'file'; uri: string; mimeType: string | null; viewMimeType: string };

const AUDIO_EXTENSION = /\.(m4a|aac|mp3|wav|caf|ogg|oga|3gp|3gpp)$/i;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

// Extension fallback for attachments whose stored mimeType is missing: an untyped VIEW intent
// makes Android show "no app can open this" even when a viewer is installed. Common document
// and media types only; anything else goes out as */* and lets the resolver decide.
const MIME_BY_EXTENSION: Record<string, string> = {
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    odt: 'application/vnd.oasis.opendocument.text',
    ods: 'application/vnd.oasis.opendocument.spreadsheet',
    epub: 'application/epub+zip',
    zip: 'application/zip',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
};

/** The MIME type Android's ACTION_VIEW gets: the stored one, else one from the extension, else any. */
export const resolveAttachmentViewMimeType = (uri: string, mimeType?: string): string => {
    const stored = mimeType?.trim();
    if (stored) return stored;
    const extension = uri.split('?')[0]?.split('.').pop()?.toLowerCase() ?? '';
    return MIME_BY_EXTENSION[extension] ?? '*/*';
};

export const isAudioAttachment = (attachment: Pick<Attachment, 'mimeType' | 'uri'>): boolean => {
    const mime = attachment.mimeType?.toLowerCase();
    if (mime?.startsWith('audio/')) return true;
    return AUDIO_EXTENSION.test(attachment.uri);
};

/** The refusal for a file validateAttachmentForUpload turned down. */
export const resolveAttachmentValidationMessage = (error: string | undefined, t: Translate): string => {
    if (error === 'file_too_large') return t('attachments.fileTooLarge');
    if (error === 'mime_type_blocked' || error === 'mime_type_not_allowed') return t('attachments.invalidFileType');
    return t('attachments.fileNotSupported');
};

/**
 * Prepare a picked file or image using React Native's metadata and validation policy.
 * This does no file IO. The UUID and timestamps are generated only here, after validation.
 */
export async function preparePickedAttachment(input: {
    source: 'file' | 'image';
    asset: PickedAttachmentAsset;
    newId: () => string;
    t: Translate;
}): Promise<PickedAttachmentPreparation> {
    const { asset, source, t } = input;
    const title = source === 'file'
        ? asset.name || 'file'
        : asset.fileName || asset.uri.split('/').pop() || 'image';
    const mimeType = asset.mimeType ?? undefined;
    // An image's picker reports fileSize; the stored size takes only that.
    const size = source === 'file' ? asset.size : asset.fileSize ?? asset.size;
    if (typeof size === 'number') {
        const validation = await validateAttachmentForUpload(
            {
                id: 'pending',
                kind: 'file',
                title,
                uri: asset.uri,
                mimeType,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
            size,
        );
        if (!validation.valid) return { kind: 'refused', message: resolveAttachmentValidationMessage(validation.error, t) };
    }
    const now = new Date().toISOString();
    const attachment: Attachment = {
        id: input.newId(),
        kind: 'file',
        title,
        uri: asset.uri,
        mimeType,
        size: (source === 'file' ? asset.size : asset.fileSize) ?? undefined,
        createdAt: now,
        updatedAt: now,
        localStatus: 'available',
    };
    return { kind: 'prepared', attachment };
}

/** Persist the prepared metadata without regenerating it. The platform receives a mutable
 * copy so its changes cannot alter the caller's retained preparation. An unchanged URI
 * retains React Native's refusal behavior; this result is not a durable copy receipt. */
export async function persistPreparedPickedAttachment(input: {
    prepared: PreparedPickedAttachment;
    persist: (attachment: Attachment) => Promise<Attachment>;
    t: Translate;
}): Promise<PickedAttachmentOutcome> {
    const { t } = input;
    const attachment = { ...input.prepared.attachment };
    const cached = await input.persist(attachment);
    if (cached.uri === attachment.uri) return { kind: 'refused', message: t('attachments.fileNotReadable') };
    return { kind: 'added', attachment: cached };
}

/** A picked file or image, as React Native adds it: prepare metadata, then copy with
 * `persist`. A copy that leaves the attachment where it was is refused. */
export async function addPickedAttachment(input: {
    source: 'file' | 'image';
    asset: PickedAttachmentAsset;
    newId: () => string;
    persist: (attachment: Attachment) => Promise<Attachment>;
    t: Translate;
}): Promise<PickedAttachmentOutcome> {
    const { t } = input;
    const prepared = await preparePickedAttachment(input);
    return prepared.kind === 'refused' ? prepared : persistPreparedPickedAttachment({
        prepared, persist: (attachment) => input.persist(attachment), t,
    });
}

/** The link field's text when editing `attachment`: "title | uri", or the uri alone. */
export const getAttachmentLinkEditText = (attachment: Pick<Attachment, 'title' | 'uri'>): string => (
    attachment.title && attachment.title !== attachment.uri
        ? `${attachment.title} | ${attachment.uri}`
        : attachment.uri
);

const isValidLinkUri = (value: string): boolean => {
    try {
        const parsed = new URL(value);
        return parsed.protocol.length > 0;
    } catch {
        return false;
    }
};

/** Saving an edited link: the fields to apply to it, or the refusal. */
export function planAttachmentLinkEdit(text: string, now: string, t: Translate):
    | { kind: 'refused'; message: string }
    | { kind: 'edit'; patch: Pick<Attachment, 'kind' | 'title' | 'uri' | 'updatedAt'> } {
    const normalized = normalizeLinkAttachmentInput(text);
    if (!normalized.uri || !isValidLinkUri(normalized.uri)) return { kind: 'refused', message: t('attachments.invalidLink') };
    return { kind: 'edit', patch: { kind: 'link', title: normalized.title, uri: normalized.uri, updatedAt: now } };
}

/**
 * Adding links: one per line, each with an optional title. A line that is not a link refuses
 * the whole paste (`refused`); text with no line adds nothing (`nothing`).
 */
export function planAttachmentLinkBatch(text: string, input: { newId: () => string; now: string; t: Translate }):
    | { kind: 'refused'; message: string }
    | { kind: 'nothing' }
    | { kind: 'add'; added: Attachment[] } {
    const batch = parseAttachmentLinkBatch(text);
    if (batch.invalidLine !== null) {
        return { kind: 'refused', message: formatI18nTemplate(input.t('attachments.invalidLinkLine'), { line: batch.invalidLine }) };
    }
    if (batch.entries.length === 0) return { kind: 'nothing' };
    return {
        kind: 'add',
        added: batch.entries.map((entry) => ({
            id: input.newId(),
            kind: entry.kind,
            title: entry.title,
            uri: entry.uri,
            createdAt: input.now,
            updatedAt: input.now,
        })),
    };
}

/** `patch` applied to the attachment `id`; the others unchanged. */
export const patchAttachment = (attachments: readonly Attachment[], id: string, patch: Partial<Attachment>): Attachment[] => (
    attachments.map((attachment) => (attachment.id === id ? { ...attachment, ...patch } : attachment))
);

/**
 * Whether `patch` changes `attachment`. A Download or Open of a file already on the device
 * brings back the fields it has; writing them anyway bumps the owner's revision, so a
 * project would sync a change nobody made (and an archived project would be rewritten).
 */
export const attachmentPatchChanges = (attachment: Attachment, patch: Partial<Attachment>): boolean => (
    Object.keys(patch).some((key) => !Object.is(attachment[key as keyof Attachment], patch[key as keyof Attachment]))
);

/** The log line that proves an unchanged Open skipped the project write (diagnostics ledger, v1.3.4). */
export const logAttachmentWriteSkipped = (): void => {
    logInfo('Project attachment open left the project unchanged', {
        scope: 'attachment',
        category: 'storage',
        context: { releaseCheck: 'v1.3.4/project-attachment-open-no-write' },
    });
};

/** Remove: a soft delete, so sync carries the removal (and its remote file's cleanup). */
export const softDeleteAttachment = (attachments: readonly Attachment[], id: string, now: string): Attachment[] => (
    patchAttachment(attachments, id, { deletedAt: now, updatedAt: now })
);

/**
 * The editor draft's attachment `attachmentId` while it still has `identity`. A synced one
 * (with a cloudKey) must also still have it in the saved task (`stored`; undefined when the
 * task or its attachment is gone, null when the editor has no saved task).
 */
export function findTaskDraftAttachmentForIdentity(input: {
    draft: readonly Attachment[];
    stored: () => Attachment | undefined | null;
    attachmentId: string;
    identity: string;
    has: AttachmentAvailabilityPort['hasAttachmentDownloadIdentity'];
}): Attachment | null {
    const draft = input.draft.find((item) => item.id === input.attachmentId);
    if (!input.has(draft, input.identity)) return null;
    if (draft.cloudKey) {
        const stored = input.stored();
        if (stored !== null && !input.has(stored ?? undefined, input.identity)) return null;
    }
    return draft;
}

/**
 * The project screen's attachment `attachmentId` while it still has `identity`: from the
 * selected project, or, for a synced one, from the stored project, which must have it too.
 */
export function findProjectAttachmentForIdentity(input: {
    selected: Project | null;
    stored: (projectId: string) => Project | undefined;
    projectId: string;
    attachmentId: string;
    identity: string;
    has: AttachmentAvailabilityPort['hasAttachmentDownloadIdentity'];
}): { project: Project; attachment: Attachment } | null {
    const { selected } = input;
    if (!selected || selected.id !== input.projectId) return null;
    const selectedAttachment = selected.attachments?.find((item) => item.id === input.attachmentId);
    if (!input.has(selectedAttachment, input.identity)) return null;
    if (!selectedAttachment.cloudKey) return { project: selected, attachment: selectedAttachment };
    const project = input.stored(input.projectId);
    const attachment = project?.attachments?.find((item) => item.id === input.attachmentId);
    if (!project || !input.has(attachment, input.identity)) return null;
    return { project, attachment };
}

/**
 * Makes a file attachment's bytes available before Download or Open: marks a synced, missing
 * file `downloading`, asks for it, then applies only the availability fields the outcome
 * brings, and only while the attachment still has the identity it started with (`update`
 * returns null once it changed: the result is `stale`). A failed download puts `missing`
 * back. A link resolves as it is.
 */
export async function resolveAttachmentAvailability(attachment: Attachment, ports: {
    availability: AttachmentAvailabilityPort;
    /** The attachment as the screen holds it now, while it still has `identity`. */
    current: (attachmentId: string, identity: string) => Attachment | null;
    /**
     * Applies `patch` while the attachment still has `identity`; the patched attachment, or null. A caller outside a store
     * command answers a Promise: it reads the row and builds its write inside one admission (store-write-gate.ts), since a
     * sync save admitted first may publish newer rows than the caller read before.
     */
    update: (attachmentId: string, identity: string, patch: Partial<Attachment>) => Attachment | null | Promise<Attachment | null>;
}): Promise<AttachmentResolution> {
    if (attachment.kind !== 'file') return { status: 'available', attachment };
    const { availability } = ports;
    const identity = availability.getAttachmentDownloadIdentity(attachment);
    if (!ports.current(attachment.id, identity)) return { status: 'stale' };
    const shouldDownload = Boolean(attachment.cloudKey && (attachment.localStatus === 'missing' || !attachment.uri));
    // The download starts at once; a queued store command marks the row meanwhile, in order before the outcome's write.
    const marking = shouldDownload && attachment.localStatus !== 'downloading'
        ? ports.update(attachment.id, identity, { localStatus: 'downloading' }) : null;
    const outcome = await availability.ensureAttachmentAvailableDetailed(attachment);
    await marking;
    if (outcome.status === 'available') {
        const current = ports.current(attachment.id, identity);
        if (!current) return { status: 'stale' };
        const resolved = await ports.update(attachment.id, identity, availability.getAttachmentAvailabilityPatch(current, outcome.attachment));
        return resolved ? { status: 'available', attachment: resolved } : { status: 'stale' };
    }
    if (outcome.status === 'unrecoverable') {
        const resolved = await ports.update(attachment.id, identity, availability.getAttachmentUnrecoverablePatch(outcome.attachment));
        return resolved ? { status: 'unrecoverable', attachment: resolved } : { status: 'stale' };
    }
    if (shouldDownload && !await ports.update(attachment.id, identity, { localStatus: 'missing' })) return { status: 'stale' };
    return outcome;
}

/** The message a Download or Open shows for `resolution`, or null when it shows none. */
export const getAttachmentResolutionMessage = (resolution: AttachmentResolution, t: Translate): string | null => {
    if (resolution.status === 'stale' || resolution.status === 'available') return null;
    if (resolution.status === 'generation-conflict') return t('attachments.downloadConflict');
    if (resolution.status === 'unrecoverable') return t('attachments.unrecoverable');
    return t('attachments.missing');
};

export const getAttachmentOpenLinkFailedMessage = (t: Translate): string => (
    tFallback(t, 'attachments.openLinkFailed', 'Could not open this link.')
);

/**
 * What opening a resolved attachment does. A "Link to file…" made on the desktop keeps that
 * computer's path (for example D:\Documents\x.docx) and is never uploaded: it is explained,
 * not handed to the OS (#1001). `audio`: the task editor plays audio; the project screen
 * opens it as a file.
 */
export function planAttachmentOpen(resolved: Attachment, input: { audio: boolean; t: Translate }): AttachmentOpenPlan {
    if (resolved.kind === 'link') {
        if (isLikelyFilePath(resolved.uri) && !URL_SCHEME.test(resolved.uri)) {
            return {
                kind: 'alert',
                message: formatI18nTemplate(tFallback(input.t, 'attachments.linkedFileElsewhere',
                    'This link points to a file on another device: {{path}}. Open it there, or attach the file instead of linking it.'), { path: resolved.uri }),
            };
        }
        return { kind: 'link', uri: resolved.uri };
    }
    if (input.audio && isAudioAttachment(resolved)) return { kind: 'audio', attachment: resolved };
    if (isImageAttachment(resolved)) return { kind: 'image', attachment: resolved };
    return {
        kind: 'file',
        uri: resolved.uri,
        mimeType: resolved.mimeType ?? null,
        viewMimeType: resolveAttachmentViewMimeType(resolved.uri, resolved.mimeType),
    };
}

/** One row of the attachment list, as React Native draws it. */
export type AttachmentRowState = {
    id: string;
    kind: Attachment['kind'];
    /** getAttachmentDisplayTitle. */
    title: string;
    /** A file with no local bytes: "Missing", or Download when `canDownload`. */
    missing: boolean;
    canDownload: boolean;
    /** "Loading", and the title does not open. */
    downloading: boolean;
};

export const getAttachmentRowState = (attachment: Attachment): AttachmentRowState => {
    const missing = attachment.kind === 'file' && (!attachment.uri || attachment.localStatus === 'missing');
    return {
        id: attachment.id,
        kind: attachment.kind,
        title: getAttachmentDisplayTitle(attachment),
        missing,
        canDownload: missing && Boolean(attachment.cloudKey),
        downloading: attachment.localStatus === 'downloading',
    };
};

// The fields that describe an attachment's bytes. The editor changes them only by a download
// (or its terminal "unrecoverable" mark), which belongs to the content it started on.
const CONTENT_FIELDS = new Set<string>(['uri', 'cloudKey', 'fileHash', 'contentRev', 'contentMtimeMs', 'contentSize',
    'size', 'mimeType', 'pendingContentUpload', 'staleContentHash', 'localStatus']);

const sameAttachmentContent = (left: Attachment, right: Attachment): boolean => (
    left.cloudKey === right.cloudKey && left.fileHash === right.fileHash && (left.contentRev ?? 0) === (right.contentRev ?? 0)
);

/**
 * The task's attachments after the editor's save: the fields the editor changed on each
 * attachment (`value` against `base`, the list the editor loaded), applied onto the stored
 * record as it is now. Everything else keeps its stored value, so a sync that recorded a
 * cloudKey, a new content revision or another device's attachment while the editor was open
 * is not undone. A record removed in storage stays removed; one storage no longer has is not
 * added back; only an attachment new to the editor is appended. A download (or its terminal
 * mark) made for content storage has since replaced is dropped: those bytes are the old
 * content's. With nothing concurrent the result equals the editor's list, as React Native's
 * replace saved it.
 */
export function mergeTaskDraftAttachments(
    stored: readonly Attachment[],
    base: readonly Attachment[],
    value: readonly Attachment[],
): Attachment[] {
    const baseById = new Map(base.map((attachment) => [attachment.id, attachment]));
    const valueById = new Map(value.map((attachment) => [attachment.id, attachment]));
    const merged = stored.map((record) => {
        const before = baseById.get(record.id);
        const after = valueById.get(record.id);
        if (!before || !after || record.deletedAt) return record;
        const keys = new Set([...Object.keys(before), ...Object.keys(after)] as (keyof Attachment)[]);
        let changed = [...keys].filter((key) => !taskEditValuesEqual(before[key], after[key]));
        if (!sameAttachmentContent(record, before)) {
            if (changed.includes('cloudKey')) return record;
            changed = changed.filter((key) => !CONTENT_FIELDS.has(key));
        }
        if (changed.length === 0) return record;
        const next: Record<string, unknown> = { ...record };
        for (const key of changed) {
            if (after[key] === undefined) delete next[key];
            else next[key] = after[key];
        }
        return next as unknown as Attachment;
    });
    const storedIds = new Set(stored.map((attachment) => attachment.id));
    for (const attachment of value) {
        if (!storedIds.has(attachment.id) && !baseById.has(attachment.id)) merged.push(attachment);
    }
    return merged;
}

/**
 * An attachment URI as a log line may name it: its scheme and its file extension. Never the
 * rest: a link can carry a user name, a password or a token, and a file name is the user's.
 */
export const describeAttachmentUriForLog = (uri: string | undefined): string => {
    if (!uri) return 'none';
    const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(uri)?.[0] ?? '';
    const path = uri.split(/[?#]/, 1)[0] ?? '';
    const extension = /\.[A-Za-z0-9]{1,8}$/.exec(path.slice(path.lastIndexOf('/') + 1))?.[0] ?? '';
    return `${scheme || 'path:'}${extension}`;
};
