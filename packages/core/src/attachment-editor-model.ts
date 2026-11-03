


import type { Attachment, Project } from './types';
import type { AttachmentAvailabilityOutcome } from './mobile-attachment-availability';
import { getAttachmentDisplayTitle, normalizeLinkAttachmentInput, parseAttachmentLinkBatch } from './attachment-link-utils';
import { validateAttachmentForUpload } from './attachment-validation';
import { formatI18nTemplate, tFallback } from './i18n';
import { isLikelyFilePath } from './mobile-sync-utils';
import { isImageAttachment } from './task-view-model';
import { isAttachmentKeptWithoutFile } from './unreachable-attachments';
import { taskEditValuesEqual } from './json-value-equality';
import { logInfo } from './logger';

type Translate = (key: string) => string;


export type PickedAttachmentAsset = {
    uri: string;
    name?: string | null;
    fileName?: string | null;
    mimeType?: string | null;
    size?: number | null;
    fileSize?: number | null;
};


export type PickedAttachmentOutcome =
    | { kind: 'refused'; message: string }
    | { kind: 'added'; attachment: Attachment };


export type PreparedPickedAttachment = {
    kind: 'prepared';
    attachment: Readonly<Attachment>;
};
export type PickedAttachmentPreparation =
    | { kind: 'refused'; message: string }
    | PreparedPickedAttachment;


export type AttachmentResolution = AttachmentAvailabilityOutcome | { status: 'stale' };


export type AttachmentAvailabilityPort = {
    ensureAttachmentAvailableDetailed(attachment: Attachment): Promise<AttachmentAvailabilityOutcome>;
    getAttachmentDownloadIdentity(attachment: Attachment): string;
    hasAttachmentDownloadIdentity(attachment: Attachment | undefined, identity: string): attachment is Attachment;
    getAttachmentAvailabilityPatch(current: Attachment, resolved: Attachment): Partial<Attachment>;
    getAttachmentUnrecoverablePatch(resolved: Attachment): Partial<Attachment>;
};


export type AttachmentOpenPlan =

    | { kind: 'alert'; message: string }

    | { kind: 'link'; uri: string }

    | { kind: 'audio'; attachment: Attachment }

    | { kind: 'image'; attachment: Attachment }

    | { kind: 'file'; uri: string; mimeType: string | null; viewMimeType: string };

const AUDIO_EXTENSION = /\.(m4a|aac|mp3|wav|caf|ogg|oga|3gp|3gpp)$/i;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;


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


export const resolveAttachmentValidationMessage = (error: string | undefined, t: Translate): string => {
    if (error === 'file_too_large') return t('attachments.fileTooLarge');
    if (error === 'mime_type_blocked' || error === 'mime_type_not_allowed') return t('attachments.invalidFileType');
    return t('attachments.fileNotSupported');
};


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


export function planAttachmentLinkEdit(text: string, now: string, t: Translate):
    | { kind: 'refused'; message: string }
    | { kind: 'edit'; patch: Pick<Attachment, 'kind' | 'title' | 'uri' | 'updatedAt'> } {
    const normalized = normalizeLinkAttachmentInput(text);
    if (!normalized.uri || !isValidLinkUri(normalized.uri)) return { kind: 'refused', message: t('attachments.invalidLink') };
    return { kind: 'edit', patch: { kind: 'link', title: normalized.title, uri: normalized.uri, updatedAt: now } };
}


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


export const patchAttachment = (attachments: readonly Attachment[], id: string, patch: Partial<Attachment>): Attachment[] => (
    attachments.map((attachment) => (attachment.id === id ? { ...attachment, ...patch } : attachment))
);


export const attachmentPatchChanges = (attachment: Attachment, patch: Partial<Attachment>): boolean => (
    Object.keys(patch).some((key) => !Object.is(attachment[key as keyof Attachment], patch[key as keyof Attachment]))
);


export const logAttachmentWriteSkipped = (): void => {
    logInfo('Project attachment open left the project unchanged', {
        scope: 'attachment',
        category: 'storage',
        context: { releaseCheck: 'v1.3.4/project-attachment-open-no-write' },
    });
};


export const softDeleteAttachment = (attachments: readonly Attachment[], id: string, now: string): Attachment[] => (
    patchAttachment(attachments, id, { deletedAt: now, updatedAt: now })
);


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


export async function resolveAttachmentAvailability(attachment: Attachment, ports: {
    availability: AttachmentAvailabilityPort;

    current: (attachmentId: string, identity: string) => Attachment | null;


    update: (attachmentId: string, identity: string, patch: Partial<Attachment>) => Attachment | null | Promise<Attachment | null>;
}): Promise<AttachmentResolution> {
    if (attachment.kind !== 'file') return { status: 'available', attachment };
    const { availability } = ports;
    const identity = availability.getAttachmentDownloadIdentity(attachment);
    if (!ports.current(attachment.id, identity)) return { status: 'stale' };
    const shouldDownload = Boolean(attachment.cloudKey && (attachment.localStatus === 'missing' || !attachment.uri));

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


export const getAttachmentResolutionMessage = (resolution: AttachmentResolution, t: Translate): string | null => {
    if (resolution.status === 'stale' || resolution.status === 'available') return null;
    if (resolution.status === 'generation-conflict') return t('attachments.downloadConflict');
    if (resolution.status === 'unrecoverable') return t('attachments.unrecoverable');
    return t('attachments.missing');
};

export const getAttachmentOpenLinkFailedMessage = (t: Translate): string => (
    tFallback(t, 'attachments.openLinkFailed', 'Could not open this link.')
);


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


export type AttachmentRowState = {
    id: string;
    kind: Attachment['kind'];

    title: string;

    missing: boolean;
    canDownload: boolean;

    downloading: boolean;
};

export const getAttachmentRowState = (attachment: Attachment): AttachmentRowState => {
    const missing = attachment.kind === 'file' && (!attachment.uri || attachment.localStatus === 'missing');
    return {
        id: attachment.id,
        kind: attachment.kind,
        title: getAttachmentDisplayTitle(attachment),
        missing,
        canDownload: missing && Boolean(attachment.cloudKey) && !isAttachmentKeptWithoutFile(attachment),
        downloading: attachment.localStatus === 'downloading',
    };
};


const CONTENT_FIELDS = new Set<string>(['uri', 'cloudKey', 'fileHash', 'contentRev', 'contentMtimeMs', 'contentSize',
    'size', 'mimeType', 'pendingContentUpload', 'staleContentHash', 'localStatus']);

const sameAttachmentContent = (left: Attachment, right: Attachment): boolean => (
    left.cloudKey === right.cloudKey && left.fileHash === right.fileHash && (left.contentRev ?? 0) === (right.contentRev ?? 0)
);


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


export const describeAttachmentUriForLog = (uri: string | undefined): string => {
    if (!uri) return 'none';
    const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(uri)?.[0] ?? '';
    const path = uri.split(/[?#]/, 1)[0] ?? '';
    const extension = /\.[A-Za-z0-9]{1,8}$/.exec(path.slice(path.lastIndexOf('/') + 1))?.[0] ?? '';
    return `${scheme || 'path:'}${extension}`;
};
