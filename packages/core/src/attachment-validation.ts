import type { Attachment } from './types';

export type AttachmentValidationError =
    | 'file_too_large'
    | 'mime_type_blocked'
    | 'mime_type_not_allowed'
    | 'file_not_found';

export interface AttachmentValidationConfig {
    maxFileSizeBytes: number;
    allowedMimeTypes?: string[];
    blockedMimeTypes?: string[];
}

export interface ValidationResult {
    valid: boolean;
    error?: AttachmentValidationError;
    details?: string;
}

export const DEFAULT_MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
const DEFAULT_BLOCKED_MIME_TYPES = [
    'application/x-executable',
    'application/x-msdos-program',
    'application/x-msdownload',
];

const normalizeMimeType = (value?: string): string => (value || '').trim().toLowerCase();

/**
 * A remote "not found" for an attachment's file. Only an activation probe's trial copy is marked
 * unrecoverable: its proof reads that tombstone, and the trial is never published. Anywhere else
 * the row stays live and keyed and the caller backs off: a tombstone would sync to every device,
 * the location that still holds the file would then delete it, and another device may still
 * upload it here. Answers whether the attachment changed.
 */
export const handleRemoteAttachmentNotFound = (attachment: Attachment, activationProbe: boolean): boolean => (
    activationProbe ? markAttachmentUnrecoverable(attachment) : false
);

export const markAttachmentUnrecoverable = (attachment: Attachment): boolean => {
    const now = new Date().toISOString();
    let mutated = false;
    if (attachment.cloudKey !== undefined) {
        attachment.cloudKey = undefined;
        mutated = true;
    }
    if (attachment.fileHash !== undefined) {
        attachment.fileHash = undefined;
        mutated = true;
    }
    if (attachment.localStatus !== 'missing') {
        attachment.localStatus = 'missing';
        mutated = true;
    }
    if (!attachment.deletedAt) {
        attachment.deletedAt = now;
        mutated = true;
    }
    if (attachment.updatedAt !== now) {
        attachment.updatedAt = now;
        mutated = true;
    }
    return mutated;
};

/** A refused replacement must retain both byte generations: `cloudKey` still names the
 * proven remote bytes, while the durable pending marker protects the edited local bytes and
 * keeps their unproven hash/revision out of the remote document. */
export const preserveRefusedAttachmentContentUpload = (attachment: Attachment): boolean => (
    attachment.pendingContentUpload === true && attachment.cloudKey !== undefined
);

export async function validateAttachmentForUpload(
    attachment: Attachment,
    fileSizeBytes: number | null | undefined,
    config?: Partial<AttachmentValidationConfig>
): Promise<ValidationResult> {
    const maxFileSizeBytes = config?.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
    const blockedMimeTypes = (config?.blockedMimeTypes ?? DEFAULT_BLOCKED_MIME_TYPES).map(normalizeMimeType);
    const allowedMimeTypes = config?.allowedMimeTypes?.map(normalizeMimeType);

    if (!Number.isFinite(fileSizeBytes ?? NaN)) {
        return { valid: false, error: 'file_not_found', details: 'Missing file size.' };
    }

    if (fileSizeBytes! > maxFileSizeBytes) {
        return { valid: false, error: 'file_too_large', details: `Max ${maxFileSizeBytes} bytes.` };
    }

    const mimeType = normalizeMimeType(attachment.mimeType);
    if (mimeType && blockedMimeTypes.includes(mimeType)) {
        return { valid: false, error: 'mime_type_blocked', details: mimeType };
    }

    if (allowedMimeTypes && allowedMimeTypes.length > 0) {
        if (!mimeType || !allowedMimeTypes.includes(mimeType)) {
            return { valid: false, error: 'mime_type_not_allowed', details: mimeType || 'unknown' };
        }
    }

    return { valid: true };
}
