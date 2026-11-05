


import { validateAttachmentForUpload } from './attachment-validation';
import type { PersistAttachmentOutcome } from './mobile-attachment-files';
import type { Attachment, Task } from './types';

export type SharedIntentFile = {
    fileName?: string | null;
    mimeType?: string | null;
    path?: string | null;
    size?: number | null;
};

export type ShareIntentFileCaptureResult = {
    params: Record<string, string> | null;
    candidateCount: number;
    attachedCount: number;
};

type ShareLogContext = { scope: string; extra?: Record<string, string> };


export type ShareIntentFileCaptureHost = {
    newId: () => string;
    persistAttachmentLocallyDetailed: (attachment: Attachment) => Promise<PersistAttachmentOutcome>;
    deleteFile: (uri: string) => Promise<unknown>;
    logWarn: (message: string, context: ShareLogContext) => unknown;
    logError: (error: unknown, context: ShareLogContext) => unknown;
};

export const SHARE_INTENT_MAX_FILES = 6;

const trimSharedValue = (value: string | null | undefined): string => (
    typeof value === 'string' ? value.trim() : ''
);

const stripFileExtension = (value: string): string => value.replace(/\.[A-Za-z0-9]{1,8}$/, '');


export async function buildShareIntentFileCaptureParams({
    files,
    shareSubject,
    shareText,
}: {
    files?: SharedIntentFile[] | null;
    shareSubject?: string | null;
    shareText?: string | null;
}, host: ShareIntentFileCaptureHost): Promise<ShareIntentFileCaptureResult> {
    const candidates = (files ?? [])
        .filter((file): file is SharedIntentFile & { path: string } => (
            typeof file?.path === 'string' && file.path.trim().length > 0
        ))
        .slice(0, SHARE_INTENT_MAX_FILES);
    if (candidates.length === 0) return { params: null, candidateCount: 0, attachedCount: 0 };

    const attachments: Attachment[] = [];
    for (const file of candidates) {
        const now = new Date().toISOString();
        const sourceUri = file.path.startsWith('/') ? `file://${file.path}` : file.path;
        const attachment: Attachment = {
            id: host.newId(),
            kind: 'file',
            title: trimSharedValue(file.fileName) || 'Shared file',
            uri: sourceUri,
            mimeType: trimSharedValue(file.mimeType) || undefined,
            size: typeof file.size === 'number' && Number.isFinite(file.size) ? file.size : undefined,
            createdAt: now,
            updatedAt: now,
            localStatus: 'available',
        };
        try {


            const validation = await validateAttachmentForUpload(attachment, attachment.size ?? 0);
            if (!validation.valid) {
                void host.logWarn('Skipped shared file failing attachment validation', {
                    scope: 'share-intent',
                    extra: { error: validation.error ?? 'unknown', size: String(attachment.size ?? 'unknown') },
                });
                continue;
            }
            const persisted = await host.persistAttachmentLocallyDetailed(attachment);
            if (persisted.status !== 'copied' && persisted.status !== 'already-local') {


                void host.logWarn('Failed to copy shared file into attachments', {
                    scope: 'share-intent',
                    extra: { status: persisted.status },
                });
                continue;
            }
            const cached = persisted.attachment;
            if (typeof attachment.size !== 'number' && typeof cached.size === 'number') {


                const sizeValidation = await validateAttachmentForUpload(cached, cached.size);
                if (!sizeValidation.valid) {
                    void host.deleteFile(cached.uri).catch(() => undefined);
                    void host.logWarn('Skipped shared file failing attachment validation', {
                        scope: 'share-intent',
                        extra: { error: sizeValidation.error ?? 'unknown', size: String(cached.size) },
                    });
                    continue;
                }
            }
            attachments.push(cached);
        } catch (error) {
            void host.logError(error, { scope: 'share-intent', extra: { step: 'copy-shared-file' } });
        }
    }
    if (attachments.length === 0) {
        return { params: null, candidateCount: candidates.length, attachedCount: 0 };
    }

    const subject = trimSharedValue(shareSubject);
    const text = trimSharedValue(shareText);
    const title = subject || text || stripFileExtension(attachments[0].title);
    const props: Partial<Task> = { attachments };


    if (subject && text) {
        props.description = text;
    }
    return {
        params: {
            initialValue: encodeURIComponent(title),
            initialProps: encodeURIComponent(JSON.stringify(props satisfies Partial<Task>)),
        },
        candidateCount: candidates.length,
        attachedCount: attachments.length,
    };
}
