import {
    AppData,
    Attachment,
    computeSha256Hex,
    globalProgressTracker,
} from '@mindwtr/core';
import { createCooperativeYield, stripFileScheme } from './sync-service-utils';

type PendingRemoteAttachmentDeleteEntry = NonNullable<
    NonNullable<AppData['settings']['attachments']>['pendingRemoteDeletes']
>[number];

export const normalizePendingRemoteDeletes = (
    value: AppData['settings']['attachments'] extends { pendingRemoteDeletes?: infer T } ? T : unknown
): PendingRemoteAttachmentDeleteEntry[] => {
    if (!Array.isArray(value)) return [];
    const deduped = new Map<string, PendingRemoteAttachmentDeleteEntry>();
    for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const cloudKey = typeof item.cloudKey === 'string' ? item.cloudKey.trim() : '';
        if (!cloudKey) continue;
        const next: PendingRemoteAttachmentDeleteEntry = {
            cloudKey,
            title: typeof item.title === 'string' ? item.title : undefined,
            attempts: typeof item.attempts === 'number' && Number.isFinite(item.attempts)
                ? Math.max(0, Math.floor(item.attempts))
                : 0,
            lastErrorAt: typeof item.lastErrorAt === 'string' ? item.lastErrorAt : undefined,
        };
        const existing = deduped.get(cloudKey);
        if (!existing || (next.attempts ?? 0) >= (existing.attempts ?? 0)) {
            deduped.set(cloudKey, next);
        }
    }
    return Array.from(deduped.values());
};

export const validateAttachmentHash = async (attachment: Attachment, bytes: Uint8Array): Promise<void> => {
    const expected = attachment.fileHash;
    if (!expected || expected.length !== 64) return;
    const computed = await computeSha256Hex(bytes);
    if (!computed) return;
    if (computed.toLowerCase() !== expected.toLowerCase()) {
        throw new Error('Integrity validation failed');
    }
};

export const reportProgress = (
    attachmentId: string,
    operation: 'upload' | 'download',
    loaded: number,
    total: number,
    status: 'active' | 'completed' | 'failed',
    error?: string,
) => {
    const percentage = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
    globalProgressTracker.updateProgress(attachmentId, {
        operation,
        bytesTransferred: loaded,
        totalBytes: total,
        percentage,
        status,
        error,
    });
};

export const collectAttachmentsById = (appData: AppData): Map<string, Attachment> => {
    const attachmentsById = new Map<string, Attachment>();
    for (const task of appData.tasks) {
        if (task.deletedAt) continue;
        for (const attachment of task.attachments || []) {
            attachmentsById.set(attachment.id, attachment);
        }
    }
    for (const project of appData.projects) {
        if (project.deletedAt) continue;
        for (const attachment of project.attachments || []) {
            attachmentsById.set(attachment.id, attachment);
        }
    }
    return attachmentsById;
};

type BasicRemoteAttachmentSyncOptions = {
    attachmentsById: Map<string, Attachment>;
    localFileExists: (path: string) => Promise<boolean>;
    onUpload: (attachment: Attachment, localPath: string) => Promise<boolean>;
    onUploadError: (attachment: Attachment, error: unknown) => void;
    onDownload: (attachment: Attachment) => Promise<boolean>;
    onDownloadError: (attachment: Attachment, error: unknown) => void;
};

export async function syncBasicRemoteAttachments(options: BasicRemoteAttachmentSyncOptions): Promise<boolean> {
    let didMutate = false;
    const maybeYield = createCooperativeYield(4);

    for (const attachment of options.attachmentsById.values()) {
        await maybeYield();
        if (attachment.kind !== 'file') continue;
        if (attachment.deletedAt) continue;

        const rawUri = attachment.uri ? stripFileScheme(attachment.uri) : '';
        const isHttp = /^https?:\/\//i.test(rawUri);
        const localPath = isHttp ? '' : rawUri;
        const hasLocalPath = Boolean(localPath);
        const existsLocally = hasLocalPath ? await options.localFileExists(localPath) : false;

        const nextStatus: Attachment['localStatus'] = existsLocally ? 'available' : 'missing';
        if (attachment.localStatus !== nextStatus) {
            attachment.localStatus = nextStatus;
            didMutate = true;
        }

        if (!attachment.cloudKey && existsLocally) {
            try {
                if (await options.onUpload(attachment, localPath)) {
                    didMutate = true;
                }
            } catch (error) {
                options.onUploadError(attachment, error);
            }
        }

        if (attachment.cloudKey && !existsLocally) {
            try {
                if (await options.onDownload(attachment)) {
                    didMutate = true;
                }
            } catch (error) {
                options.onDownloadError(attachment, error);
            }
        }
    }

    return didMutate;
}

export const getBaseSyncUrl = (fullUrl: string): string => {
    const trimmed = fullUrl.replace(/\/+$/, '');
    if (trimmed.toLowerCase().endsWith('.json')) {
        const lastSlash = trimmed.lastIndexOf('/');
        return lastSlash >= 0 ? trimmed.slice(0, lastSlash) : trimmed;
    }
    return trimmed;
};

export const getCloudBaseUrl = (fullUrl: string): string => {
    const trimmed = fullUrl.replace(/\/+$/, '');
    if (trimmed.toLowerCase().endsWith('/data')) {
        return trimmed.slice(0, -'/data'.length);
    }
    return trimmed;
};
