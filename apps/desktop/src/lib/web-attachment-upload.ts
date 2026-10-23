import {
    buildCloudKey, cloudAttachmentExists, cloudDeleteFile, cloudPutFile, extractExtension, generateUUID, getCloudBaseUrl,
    isBlockedAttachmentContentRefusal, isSandboxMode, isWorkspaceTransitionActive,
    validateAttachmentForUpload, type Attachment,
} from '@mindwtr/core';
import { logInfo } from './app-log';
import { getImageExtension } from './clipboard-images';
import { getBrowserSyncConfigurationGeneration } from './sync-service-config';

export class WebAttachmentUploadError extends Error {
    constructor(readonly translationKey: string) { super(translationKey); }
}

type UploadTarget = { url: string; token?: string; allowInsecureHttp?: boolean; generation: string };
type DraftFile = {
    file: File; attachment: Attachment; target?: UploadTarget; uploaded: boolean;
    storeOwned: boolean; uncertain: boolean; removed: boolean;
};

// A staged image's bytes exist only in its draft until Save uploads them, so the description
// preview shows it from the draft's File meanwhile (#1433).
const stagedPreviewUrls = new Map<string, string>();

export function getStagedWebAttachmentPreviewUrl(id: string): string | undefined {
    return stagedPreviewUrls.get(id);
}

const releaseStagedPreview = (id: string) => {
    const url = stagedPreviewUrls.get(id);
    if (!url) return;
    stagedPreviewUrls.delete(id);
    URL.revokeObjectURL(url);
};

export async function getWebAttachmentUploadTarget(): Promise<UploadTarget> {
    if (isSandboxMode() || isWorkspaceTransitionActive()) throw new WebAttachmentUploadError('attachments.webUploadChanged');
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new WebAttachmentUploadError('attachments.webUploadOffline');
    const generation = getBrowserSyncConfigurationGeneration();
    const { SyncService } = await import('./sync-service');
    const [backend, provider, encryption, config] = await Promise.all([
        SyncService.getSyncBackend(), SyncService.getCloudProvider(),
        SyncService.getSyncEncryptionStatus(), SyncService.getCloudConfig({ silent: true }),
    ]);
    if (generation !== getBrowserSyncConfigurationGeneration() || isSandboxMode() || isWorkspaceTransitionActive()) {
        throw new WebAttachmentUploadError('attachments.webUploadChanged');
    }
    if (backend !== 'cloud' || provider !== 'selfhosted' || !config.url?.trim()) {
        throw new WebAttachmentUploadError('attachments.webUploadRequiresCloud');
    }
    if (encryption.state !== 'off' || encryption.incompleteTransition) throw new WebAttachmentUploadError('attachments.webUploadEncrypted');
    return { url: getCloudBaseUrl(config.url), token: config.token, allowInsecureHttp: config.allowInsecureHttp, generation };
}

export function webAttachmentUploadMessage(error: unknown, t: (key: string) => string): string {
    return `${t(error instanceof WebAttachmentUploadError ? error.translationKey : 'attachments.webUploadFailed')} ${t('attachments.webUploadRetry')}`;
}

export function pickBrowserAttachmentFiles(onFiles: (files: File[]) => void): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = () => onFiles(Array.from(input.files ?? []));
    input.click();
}

/** One live draft owns these Files. Only successful PUTs may enter task metadata. */
export function createWebAttachmentDraft() {
    const files = new Map<string, DraftFile>();
    let generation = 0;
    let pending: Promise<Attachment[]> | null = null;
    let controller: AbortController | null = null;

    const cleanup = (entry: DraftFile) => {
        if (!entry.uploaded || !entry.target || entry.storeOwned || entry.uncertain) return;
        entry.uploaded = false;
        const { url, ...options } = entry.target;
        void cloudDeleteFile(`${url}/${buildCloudKey(entry.attachment)}`, options).catch(() => undefined);
    };
    const assertCurrent = (expected: number, current: () => boolean) => {
        if (generation !== expected || !current() || isSandboxMode() || isWorkspaceTransitionActive()) {
            throw new WebAttachmentUploadError('attachments.webUploadChanged');
        }
    };
    return {
        stage(file: File, title = file.name): Attachment {
            generation += 1;
            const now = new Date().toISOString();
            const attachment: Attachment = {
                id: generateUUID(), kind: 'file', title: file.type.startsWith('image/') && !extractExtension(title)
                    ? `${title || 'image'}.${getImageExtension(file)}` : title || 'file', uri: '',
                mimeType: file.type || undefined, size: file.size, localStatus: 'available', createdAt: now, updatedAt: now,
            };
            files.set(attachment.id, { file, attachment, uploaded: false, storeOwned: false, uncertain: false, removed: false });
            if (file.type.startsWith('image/') && typeof URL.createObjectURL === 'function') {
                stagedPreviewUrls.set(attachment.id, URL.createObjectURL(file));
            }
            return attachment;
        },
        has(attachments: Attachment[]): boolean {
            return attachments.some((attachment) => !attachment.deletedAt && files.has(attachment.id));
        },
        prepareSave(attachments: Attachment[], current: () => boolean = () => true): Promise<Attachment[]> {
            if (pending) return pending;
            const included = attachments.filter((attachment) => !attachment.deletedAt && files.has(attachment.id));
            if (included.length === 0) return Promise.resolve(attachments);
            const expected = generation;
            controller = new AbortController();
            const signal = controller.signal;
            pending = (async () => {
                const target = await getWebAttachmentUploadTarget();
                assertCurrent(expected, current);
                const result = new Map<string, Attachment>();
                for (const attachment of included) {
                    const entry = files.get(attachment.id);
                    if (!entry || entry.removed) throw new WebAttachmentUploadError('attachments.webUploadChanged');
                    if (entry.target && (entry.target.generation !== target.generation || entry.target.url !== target.url
                        || entry.target.token !== target.token || entry.target.allowInsecureHttp !== target.allowInsecureHttp)) {
                        throw new WebAttachmentUploadError('attachments.webUploadChanged');
                    }
                    const validation = await validateAttachmentForUpload(entry.attachment, entry.file.size);
                    assertCurrent(expected, current);
                    if (!validation.valid) throw new WebAttachmentUploadError(validation.error === 'file_too_large'
                        ? 'attachments.fileTooLarge' : 'attachments.invalidFileType');
                    entry.target ??= target;
                    const cloudKey = buildCloudKey(entry.attachment);
                    const url = `${target.url}/${cloudKey}`;
                    if (entry.uploaded && !entry.storeOwned) {
                        entry.uploaded = await cloudAttachmentExists(url, { ...target, signal, partialBodyReads: true }) === true;
                        assertCurrent(expected, current);
                    }
                    if (!entry.uploaded) {
                        try {
                            // A fresh id names one immutable File; a hash would require another full byte buffer.
                            await cloudPutFile(url, entry.file, entry.attachment.mimeType || 'application/octet-stream', { ...target, signal });
                            entry.uploaded = true;
                            void logInfo('Browser attachment bytes uploaded', {
                                scope: 'attachment', force: true,
                                extra: { releaseCheck: 'v1.3.7/web-attachment-upload', stage: 'bytes-uploaded', count: 1 },
                            });
                        } catch (error) {
                            // A rejected/aborted response does not prove the server did not publish.
                            entry.uncertain = true;
                            if (isBlockedAttachmentContentRefusal(error)) throw new WebAttachmentUploadError('attachments.invalidFileType');
                            throw error;
                        } finally {
                            if (entry.removed) cleanup(entry);
                        }
                    }
                    assertCurrent(expected, current);
                    const stillCurrent = await getWebAttachmentUploadTarget();
                    assertCurrent(expected, current);
                    if (stillCurrent.generation !== target.generation || stillCurrent.url !== target.url || stillCurrent.token !== target.token) {
                        throw new WebAttachmentUploadError('attachments.webUploadChanged');
                    }
                    result.set(attachment.id, { ...attachment, uri: '', cloudKey, localStatus: undefined });
                }
                return attachments.map((attachment) => result.get(attachment.id) ?? attachment);
            })().finally(() => { pending = null; controller = null; });
            return pending;
        },
        retainBeforeStore(attachments: Attachment[]) {
            const included = attachments.flatMap((attachment) => {
                const entry = !attachment.deletedAt && files.get(attachment.id);
                return entry ? [entry] : [];
            });
            if (included.some((entry) => !entry.uploaded || entry.removed
                || entry.target?.generation !== getBrowserSyncConfigurationGeneration())
                || (included.length > 0 && (isSandboxMode() || isWorkspaceTransitionActive()))) {
                throw new WebAttachmentUploadError('attachments.webUploadChanged');
            }
            for (const attachment of attachments) {
                const entry = files.get(attachment.id);
                if (entry && !attachment.deletedAt) entry.storeOwned = true;
            }
        },
        remove(id: string) {
            const entry = files.get(id);
            if (!entry) return;
            generation += 1;
            entry.removed = true;
            files.delete(id);
            releaseStagedPreview(id);
            cleanup(entry);
        },
        discard() {
            generation += 1;
            controller?.abort();
            for (const entry of files.values()) { entry.removed = true; releaseStagedPreview(entry.attachment.id); cleanup(entry); }
            files.clear();
        },
    };
}
