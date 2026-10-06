import {
    findDeletedAttachmentsForFileCleanup,
    findLiveAttachmentResourceReferences,
    findOrphanedAttachments,
    shouldDeleteAttachmentLocalResource,
    type AttachmentCleanupPolicyAttachment,
} from './attachment-cleanup';

/** A retained native cleanup owner forbids further work until its exact retry settles. */
export class NativeAttachmentCleanupUnconfirmedError extends Error {
    constructor() {
        super('Attachment cleanup could not be confirmed; retry the retained request');
        this.name = 'NativeAttachmentCleanupUnconfirmedError';
    }
}

export type NativeAttachmentCleanupRawRow = {
    id: string;
    purgedAt: string | null;
    attachments: string | null;
};
export type NativeAttachmentCleanupProjection = {
    version: 1;
    tasks: NativeAttachmentCleanupRawRow[];
    projects: NativeAttachmentCleanupRawRow[];
};
export type NativeAttachmentCleanupWitness = {
    version: 1;
    parentKind: 'task' | 'project';
    parentID: string;
    parentPurgedAt: string | null;
    attachmentID: string;
    targetURI: string;
    attachmentJSON: string;
};

const SCALAR_BYTES = 8 * 1024 * 1024;
const FRAME_BYTES = 16 * 1024 * 1024;
const URI_BYTES = 16 * 1024;
const WITNESS_ATTACHMENT_BYTES = 64 * 1024;
const WITNESS_BYTES = 128 * 1024;
const invalid = (): never => { throw new Error('INVALID_INPUT'); };
const own = (value: object, field: string): boolean => Object.prototype.hasOwnProperty.call(value, field);
const record = (value: unknown): value is Record<string, unknown> => (
    value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
);
const exact = (value: unknown, fields: readonly string[]): value is Record<string, unknown> => (
    record(value) && fields.every((field) => own(value, field))
    && Reflect.ownKeys(value).every((field) => {
        if (typeof field !== 'string' || !fields.includes(field)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, field);
        return Boolean(descriptor?.enumerable && own(descriptor, 'value'));
    })
);
// Native JavaScript engines do not need a TextEncoder capability for this guard.
const utf8Bytes = (text: string, limit: number): number => {
    let bytes = 0;
    for (let index = 0; index < text.length; index++) {
        const unit = text.charCodeAt(index);
        if (unit < 0x80) bytes++;
        else if (unit < 0x800) bytes += 2;
        else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length
            && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
            bytes += 4; index++;
        } else bytes += 3;
        if (bytes > limit) return bytes;
    }
    return bytes;
};
const identifier = (value: unknown): value is string => (
    typeof value === 'string' && value.length > 0 && value.length <= 500 && !value.includes('\0')
);
const uri = (value: unknown): value is string => (
    typeof value === 'string' && !value.includes('\0') && value.length <= URI_BYTES
    && utf8Bytes(value, URI_BYTES) <= URI_BYTES
);
type PolicyAttachment = AttachmentCleanupPolicyAttachment & Record<string, unknown> & { kind: 'file' | 'link' };
type Parent = { id: string; purgedAt: string | null; attachments: PolicyAttachment[] };
const attachment = (value: unknown): PolicyAttachment => {
    if (!record(value) || !identifier(value.id) || !(value.kind === 'file' || value.kind === 'link')
        || !uri(value.uri)
        || own(value, 'deletedAt') && value.deletedAt !== null && typeof value.deletedAt !== 'string'
        || own(value, 'cloudKey') && value.cloudKey !== null && typeof value.cloudKey !== 'string'
        || own(value, 'localStatus') && value.localStatus !== null
            && !['available', 'missing', 'uploading', 'downloading'].includes(value.localStatus as string)) invalid();
    return value as PolicyAttachment;
};
const projection = (value: unknown): { tasks: Parent[]; projects: Parent[] } => {
    if (!exact(value, ['version', 'tasks', 'projects']) || value.version !== 1
        || !Array.isArray(value.tasks) || !Array.isArray(value.projects)
        || value.tasks.length + value.projects.length > 100_000) invalid();
    const raw = value as unknown as NativeAttachmentCleanupProjection;
    let scalarBytes = 0;
    for (const rows of [raw.tasks, raw.projects]) {
        const ids = new Set<string>();
        for (const row of rows) {
            if (!exact(row, ['id', 'purgedAt', 'attachments']) || !identifier(row.id)
                || row.purgedAt !== null && (typeof row.purgedAt !== 'string' || !row.purgedAt)
                || row.attachments !== null && typeof row.attachments !== 'string'
                || ids.has(row.id)) invalid();
            ids.add(row.id);
            for (const scalar of [row.id, row.purgedAt, row.attachments]) {
                if (typeof scalar !== 'string') continue;
                scalarBytes += utf8Bytes(scalar, SCALAR_BYTES - scalarBytes);
                if (scalarBytes > SCALAR_BYTES) invalid();
            }
        }
    }
    if (utf8Bytes(JSON.stringify(raw), FRAME_BYTES) > FRAME_BYTES) invalid();
    // Inner SQL cells are parsed only after the entire projection passes its caps.
    const parents = (rows: NativeAttachmentCleanupRawRow[]): Parent[] => rows.map((row) => {
        const values: unknown = row.attachments === null ? [] : JSON.parse(row.attachments);
        if (!Array.isArray(values) || values.length > 1000) return invalid();
        return { id: row.id, purgedAt: row.purgedAt, attachments: values.map(attachment) };
    });
    return { tasks: parents(raw.tasks), projects: parents(raw.projects) };
};
const candidate = (value: unknown): { attachmentID: string; targetURI: string } => {
    if (!exact(value, ['attachmentID', 'targetURI']) || !identifier(value.attachmentID) || !uri(value.targetURI) || !value.targetURI) invalid();
    return value as { attachmentID: string; targetURI: string };
};
const prepare = (raw: unknown, selected: unknown): NativeAttachmentCleanupWitness | null => {
    const data = projection(raw), input = candidate(selected);
    let match: { parentKind: 'task' | 'project'; parent: Parent; attachment: PolicyAttachment } | undefined;
    for (const parentKind of ['task', 'project'] as const) {
        for (const parent of parentKind === 'task' ? data.tasks : data.projects) {
            for (const entry of parent.attachments) {
                if (entry.id !== input.attachmentID) continue;
                if (match) return null;
                match = { parentKind, parent, attachment: entry };
            }
        }
    }
    if (!match || match.attachment.kind !== 'file' || match.attachment.uri !== input.targetURI) return null;
    const eligible = findOrphanedAttachments(data).includes(match.attachment)
        || findDeletedAttachmentsForFileCleanup(data).includes(match.attachment);
    if (!eligible || !shouldDeleteAttachmentLocalResource(match.attachment, findLiveAttachmentResourceReferences(data))) return null;
    const attachmentJSON = JSON.stringify(match.attachment);
    if (utf8Bytes(attachmentJSON, WITNESS_ATTACHMENT_BYTES) > WITNESS_ATTACHMENT_BYTES) invalid();
    const witness: NativeAttachmentCleanupWitness = {
        version: 1, parentKind: match.parentKind, parentID: match.parent.id,
        parentPurgedAt: match.parent.purgedAt, attachmentID: input.attachmentID,
        targetURI: input.targetURI, attachmentJSON,
    };
    if (utf8Bytes(JSON.stringify(witness), WITNESS_BYTES) > WITNESS_BYTES) invalid();
    return witness;
};

/** A policy witness only: native still owns the exact physical file proof. */
export function prepareNativeAttachmentCleanupWitness(raw: unknown, selected: unknown): NativeAttachmentCleanupWitness | null {
    try { return prepare(raw, selected); } catch { return invalid(); }
}

/** Re-run the existing cleanup policy over fresh durable rows, preserving all selected metadata. */
export function isNativeAttachmentCleanupWitnessEligible(raw: unknown, value: unknown): boolean {
    try {
        if (!exact(value, ['version', 'parentKind', 'parentID', 'parentPurgedAt', 'attachmentID', 'targetURI', 'attachmentJSON'])
            || value.version !== 1 || !(value.parentKind === 'task' || value.parentKind === 'project')
            || !identifier(value.parentID) || !identifier(value.attachmentID) || !uri(value.targetURI) || !value.targetURI
            || value.parentPurgedAt !== null && (typeof value.parentPurgedAt !== 'string' || !value.parentPurgedAt)
            || typeof value.attachmentJSON !== 'string' || value.attachmentJSON.length > WITNESS_ATTACHMENT_BYTES
            || utf8Bytes(value.attachmentJSON, WITNESS_ATTACHMENT_BYTES) > WITNESS_ATTACHMENT_BYTES) invalid();
        const witness = value as unknown as NativeAttachmentCleanupWitness;
        if (utf8Bytes(JSON.stringify(witness), WITNESS_BYTES) > WITNESS_BYTES) invalid();
        const entry = attachment(JSON.parse(witness.attachmentJSON));
        if (entry.kind !== 'file' || entry.id !== witness.attachmentID || entry.uri !== witness.targetURI) invalid();
        const fresh = prepare(raw, { attachmentID: witness.attachmentID, targetURI: witness.targetURI });
        return fresh !== null && fresh.parentKind === witness.parentKind && fresh.parentID === witness.parentID
            && fresh.parentPurgedAt === witness.parentPurgedAt && fresh.attachmentID === witness.attachmentID
            && fresh.targetURI === witness.targetURI && fresh.attachmentJSON === witness.attachmentJSON;
    } catch { return invalid(); }
}
