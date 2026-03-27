import {
    type AppData,
    type Attachment,
    createWebdavDownloadBackoff,
    cloudGetFile,
    cloudPutFile,
    getErrorStatus,
    isWebdavRateLimitedError,
    validateAttachmentForUpload,
    webdavFileExists,
    webdavGetFile,
    webdavMakeDirectory,
    webdavPutFile,
    withRetry,
} from '@mindwtr/core';

import { sanitizeLogMessage } from './app-log';
import {
    collectAttachmentsById,
    reportProgress,
    syncBasicRemoteAttachments,
    validateAttachmentHash,
} from './sync-attachments';
import {
    ATTACHMENTS_DIR_NAME,
    buildCloudKey,
    extractExtension,
    sleep,
    stripFileScheme,
    createCooperativeYield,
    writeAttachmentFileSafely,
    writeFileSafelyAbsolute,
} from './sync-service-utils';
import {
    clearAttachmentValidationFailure,
    handleAttachmentValidationFailure,
    markAttachmentUnrecoverable,
} from './sync-attachment-validation';
import {
    downloadDropboxFile,
    DropboxFileNotFoundError,
    DropboxUnauthorizedError,
    uploadDropboxFile,
} from './dropbox-sync';

export type WebDavConfig = { url: string; username: string; password?: string; hasPassword?: boolean };
export type CloudConfig = { url: string; token: string };

export type AttachmentBackendDeps = {
    getTauriFetch: () => Promise<typeof fetch | undefined>;
    isTauriRuntimeEnv: () => boolean;
    logSyncInfo: (message: string, extra?: Record<string, string>) => void;
    logSyncWarning: (message: string, error?: unknown) => void;
    resolveWebdavPassword: (config: WebDavConfig) => Promise<string>;
};

const LOCAL_ATTACHMENTS_DIR = `mindwtr/${ATTACHMENTS_DIR_NAME}`;
const FILE_BACKEND_VALIDATION_CONFIG = {
    maxFileSizeBytes: Number.POSITIVE_INFINITY,
    blockedMimeTypes: [],
};
const UPLOAD_TIMEOUT_MS = 120_000;
const WEBDAV_ATTACHMENT_RETRY_OPTIONS = { maxAttempts: 5, baseDelayMs: 2000, maxDelayMs: 60_000 };
const CLOUD_ATTACHMENT_RETRY_OPTIONS = { maxAttempts: 5, baseDelayMs: 2000, maxDelayMs: 60_000 };
const WEBDAV_ATTACHMENT_MIN_INTERVAL_MS = 400;
const WEBDAV_ATTACHMENT_COOLDOWN_MS = 60_000;
const WEBDAV_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC = 10;
const WEBDAV_ATTACHMENT_MAX_UPLOADS_PER_SYNC = 10;
const WEBDAV_ATTACHMENT_MISSING_BACKOFF_MS = 15 * 60_000;
const WEBDAV_ATTACHMENT_ERROR_BACKOFF_MS = 2 * 60_000;

const webdavDownloadBackoff = createWebdavDownloadBackoff({
    missingBackoffMs: WEBDAV_ATTACHMENT_MISSING_BACKOFF_MS,
    errorBackoffMs: WEBDAV_ATTACHMENT_ERROR_BACKOFF_MS,
});

export const clearAttachmentSyncState = (): void => {
    webdavDownloadBackoff.clear();
};

const getWebdavDownloadBackoff = (attachmentId: string): number | null => {
    return webdavDownloadBackoff.getBlockedUntil(attachmentId);
};

const setWebdavDownloadBackoff = (attachmentId: string, error: unknown): void => {
    webdavDownloadBackoff.setFromError(attachmentId, error);
};

const pruneWebdavDownloadBackoff = (): void => {
    webdavDownloadBackoff.prune();
};

export async function syncWebdavAttachments(
    appData: AppData,
    webDavConfig: WebDavConfig,
    baseSyncUrl: string,
    deps: AttachmentBackendDeps,
): Promise<AppData | null> {
    if (!deps.isTauriRuntimeEnv()) return null;
    if (!webDavConfig.url) return null;

    const fetcher = await deps.getTauriFetch();
    const { BaseDirectory, exists, mkdir, readFile, writeFile, rename, remove } = await import('@tauri-apps/plugin-fs');
    const { dataDir, join } = await import('@tauri-apps/api/path');
    const password = await deps.resolveWebdavPassword(webDavConfig);

    const attachmentsDirUrl = `${baseSyncUrl}/${ATTACHMENTS_DIR_NAME}`;
    try {
        await webdavMakeDirectory(attachmentsDirUrl, {
            username: webDavConfig.username,
            password,
            fetcher,
        });
    } catch (error) {
        deps.logSyncWarning('Failed to ensure WebDAV attachments directory', error);
    }

    try {
        await mkdir(LOCAL_ATTACHMENTS_DIR, { baseDir: BaseDirectory.Data, recursive: true });
    } catch (error) {
        deps.logSyncWarning('Failed to ensure local attachments directory', error);
    }

    const baseDataDir = await dataDir();
    const workingData = structuredClone(appData);
    const attachmentsById = collectAttachmentsById(workingData);

    pruneWebdavDownloadBackoff();
    deps.logSyncInfo('WebDAV attachment sync start', { count: String(attachmentsById.size) });

    let lastRequestAt = 0;
    let blockedUntil = 0;
    const waitForSlot = async (): Promise<void> => {
        const now = Date.now();
        if (blockedUntil && now < blockedUntil) {
            throw new Error(`WebDAV rate limited for ${blockedUntil - now}ms`);
        }
        const elapsed = now - lastRequestAt;
        if (elapsed < WEBDAV_ATTACHMENT_MIN_INTERVAL_MS) {
            await sleep(WEBDAV_ATTACHMENT_MIN_INTERVAL_MS - elapsed);
        }
        lastRequestAt = Date.now();
    };
    const handleRateLimit = (error: unknown): boolean => {
        if (!isWebdavRateLimitedError(error)) return false;
        blockedUntil = Date.now() + WEBDAV_ATTACHMENT_COOLDOWN_MS;
        deps.logSyncWarning('WebDAV rate limited; pausing attachment sync', error);
        return true;
    };

    const readLocalFile = async (path: string): Promise<Uint8Array> => {
        if (path.startsWith(baseDataDir)) {
            const relative = path.slice(baseDataDir.length).replace(/^[\\/]/, '');
            return await readFile(relative, { baseDir: BaseDirectory.Data });
        }
        return await readFile(path);
    };

    const localFileExists = async (path: string): Promise<boolean> => {
        try {
            if (path.startsWith(baseDataDir)) {
                const relative = path.slice(baseDataDir.length).replace(/^[\\/]/, '');
                return await exists(relative, { baseDir: BaseDirectory.Data });
            }
            return await exists(path);
        } catch (error) {
            deps.logSyncWarning('Failed to check attachment file', error);
            return false;
        }
    };

    let didMutate = false;
    const downloadQueue: Attachment[] = [];
    let abortedByRateLimit = false;
    let uploadCount = 0;
    let uploadLimitLogged = false;
    const maybeYieldAttachmentLoop = createCooperativeYield(4);

    for (const attachment of attachmentsById.values()) {
        await maybeYieldAttachmentLoop();
        if (attachment.kind !== 'file' || attachment.deletedAt || abortedByRateLimit) continue;

        const rawUri = attachment.uri ? stripFileScheme(attachment.uri) : '';
        const isHttp = /^https?:\/\//i.test(rawUri);
        const localPath = isHttp ? '' : rawUri;
        const hasLocalPath = Boolean(localPath);
        const existsLocally = hasLocalPath ? await localFileExists(localPath) : false;
        deps.logSyncInfo('WebDAV attachment check', {
            id: attachment.id,
            title: attachment.title || 'attachment',
            uri: localPath || rawUri,
            cloud: attachment.cloudKey ? 'set' : 'missing',
            local: hasLocalPath ? 'true' : 'false',
            exists: existsLocally ? 'true' : 'false',
        });

        const nextStatus: Attachment['localStatus'] = existsLocally ? 'available' : 'missing';
        if (attachment.localStatus !== nextStatus) {
            attachment.localStatus = nextStatus;
            didMutate = true;
        }
        if (existsLocally) {
            webdavDownloadBackoff.deleteEntry(attachment.id);
        }

        if (attachment.cloudKey && existsLocally) {
            try {
                const remoteExists = await withRetry(
                    async () => {
                        await waitForSlot();
                        return await webdavFileExists(`${baseSyncUrl}/${attachment.cloudKey}`, {
                            username: webDavConfig.username,
                            password,
                            fetcher,
                        });
                    },
                    WEBDAV_ATTACHMENT_RETRY_OPTIONS,
                );
                deps.logSyncInfo('WebDAV attachment remote exists', {
                    id: attachment.id,
                    exists: remoteExists ? 'true' : 'false',
                });
                if (!remoteExists) {
                    attachment.cloudKey = undefined;
                    didMutate = true;
                }
            } catch (error) {
                if (handleRateLimit(error)) {
                    abortedByRateLimit = true;
                    break;
                }
                deps.logSyncWarning('Failed to check WebDAV attachment remote status', error);
            }
        }

        if (!attachment.cloudKey && existsLocally) {
            if (uploadCount >= WEBDAV_ATTACHMENT_MAX_UPLOADS_PER_SYNC) {
                if (!uploadLimitLogged) {
                    deps.logSyncInfo('WebDAV attachment upload limit reached', {
                        limit: String(WEBDAV_ATTACHMENT_MAX_UPLOADS_PER_SYNC),
                    });
                    uploadLimitLogged = true;
                }
                continue;
            }
            uploadCount += 1;
            const cloudKey = buildCloudKey(attachment);
            try {
                const fileData = await readLocalFile(localPath);
                const validation = await validateAttachmentForUpload(attachment, fileData.length);
                if (!validation.valid) {
                    const failure = handleAttachmentValidationFailure(attachment, validation.error);
                    reportProgress(attachment.id, 'upload', 0, attachment.size ?? fileData.length, 'failed', failure.message);
                    deps.logSyncWarning(
                        failure.reachedLimit
                            ? `${failure.message}; marking attachment unrecoverable`
                            : failure.message,
                    );
                    didMutate = didMutate || failure.mutated;
                    continue;
                }
                clearAttachmentValidationFailure(attachment.id);
                reportProgress(attachment.id, 'upload', 0, fileData.length, 'active');
                deps.logSyncInfo('WebDAV attachment upload start', {
                    id: attachment.id,
                    bytes: String(fileData.length),
                    cloudKey,
                });
                await withRetry(
                    async () => {
                        await waitForSlot();
                        return await webdavPutFile(
                            `${baseSyncUrl}/${cloudKey}`,
                            fileData,
                            attachment.mimeType || 'application/octet-stream',
                            {
                                headers: { 'Content-Length': String(fileData.length) },
                                username: webDavConfig.username,
                                password,
                                fetcher,
                                timeoutMs: UPLOAD_TIMEOUT_MS,
                            },
                        );
                    },
                    {
                        ...WEBDAV_ATTACHMENT_RETRY_OPTIONS,
                        onRetry: (error, attempt, delayMs) => {
                            deps.logSyncInfo('Retrying WebDAV attachment upload', {
                                id: attachment.id,
                                attempt: String(attempt + 1),
                                delayMs: String(delayMs),
                                error: sanitizeLogMessage(error instanceof Error ? error.message : String(error)),
                            });
                        },
                    },
                );
                attachment.cloudKey = cloudKey;
                attachment.localStatus = 'available';
                didMutate = true;
                reportProgress(attachment.id, 'upload', fileData.length, fileData.length, 'completed');
                deps.logSyncInfo('WebDAV attachment upload done', {
                    id: attachment.id,
                    bytes: String(fileData.length),
                });
            } catch (error) {
                if (handleRateLimit(error)) {
                    abortedByRateLimit = true;
                    break;
                }
                reportProgress(
                    attachment.id,
                    'upload',
                    0,
                    attachment.size ?? 0,
                    'failed',
                    error instanceof Error ? error.message : String(error),
                );
                deps.logSyncWarning(`Failed to upload attachment ${attachment.title}`, error);
            }
            continue;
        }

        if (attachment.cloudKey && !existsLocally) {
            downloadQueue.push(attachment);
        }
    }

    let downloadCount = 0;
    for (const attachment of downloadQueue) {
        await maybeYieldAttachmentLoop();
        if (attachment.kind !== 'file' || attachment.deletedAt || abortedByRateLimit || !attachment.cloudKey) continue;
        if (getWebdavDownloadBackoff(attachment.id)) continue;
        if (downloadCount >= WEBDAV_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC) {
            deps.logSyncInfo('WebDAV attachment download limit reached', {
                limit: String(WEBDAV_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC),
            });
            break;
        }
        downloadCount += 1;

        const cloudKey = attachment.cloudKey;
        try {
            const fileData = await withRetry(
                async () => {
                    await waitForSlot();
                    return await webdavGetFile(`${baseSyncUrl}/${cloudKey}`, {
                        username: webDavConfig.username,
                        password,
                        fetcher,
                        onProgress: (loaded, total) => reportProgress(attachment.id, 'download', loaded, total, 'active'),
                    });
                },
                WEBDAV_ATTACHMENT_RETRY_OPTIONS,
            );
            const bytes = fileData instanceof ArrayBuffer ? new Uint8Array(fileData) : new Uint8Array(fileData as ArrayBuffer);
            await validateAttachmentHash(attachment, bytes);
            const filename = cloudKey.split('/').pop() || `${attachment.id}${extractExtension(attachment.uri)}`;
            const relativePath = `${LOCAL_ATTACHMENTS_DIR}/${filename}`;
            await writeAttachmentFileSafely(relativePath, bytes, {
                baseDir: BaseDirectory.Data,
                writeFile,
                rename,
                remove,
            });
            attachment.uri = await join(baseDataDir, relativePath);
            if (attachment.localStatus !== 'available') {
                attachment.localStatus = 'available';
                didMutate = true;
            }
            webdavDownloadBackoff.deleteEntry(attachment.id);
            reportProgress(attachment.id, 'download', bytes.length, bytes.length, 'completed');
        } catch (error) {
            if (handleRateLimit(error)) {
                abortedByRateLimit = true;
                break;
            }
            const status = getErrorStatus(error);
            if (status === 404 && attachment.cloudKey) {
                webdavDownloadBackoff.deleteEntry(attachment.id);
                if (markAttachmentUnrecoverable(attachment)) {
                    didMutate = true;
                }
                deps.logSyncInfo('Cleared missing WebDAV cloud key after 404', {
                    id: attachment.id,
                });
            } else {
                setWebdavDownloadBackoff(attachment.id, error);
            }
            if (status !== 404 && attachment.localStatus !== 'missing') {
                attachment.localStatus = 'missing';
                didMutate = true;
            }
            reportProgress(
                attachment.id,
                'download',
                0,
                attachment.size ?? 0,
                'failed',
                error instanceof Error ? error.message : String(error),
            );
            deps.logSyncWarning(`Failed to download attachment ${attachment.title}`, error);
        }
    }

    if (abortedByRateLimit) {
        deps.logSyncWarning('WebDAV attachment sync aborted due to rate limiting');
    }
    deps.logSyncInfo('WebDAV attachment sync done', { mutated: didMutate ? 'true' : 'false' });
    return didMutate ? workingData : null;
}

export async function syncCloudAttachments(
    appData: AppData,
    cloudConfig: CloudConfig,
    baseSyncUrl: string,
    deps: AttachmentBackendDeps,
): Promise<boolean> {
    if (!deps.isTauriRuntimeEnv() || !cloudConfig.url) return false;

    const fetcher = await deps.getTauriFetch();
    const { BaseDirectory, exists, mkdir, readFile, writeFile, rename, remove } = await import('@tauri-apps/plugin-fs');
    const { dataDir, join } = await import('@tauri-apps/api/path');

    try {
        await mkdir(LOCAL_ATTACHMENTS_DIR, { baseDir: BaseDirectory.Data, recursive: true });
    } catch (error) {
        deps.logSyncWarning('Failed to ensure local attachments directory', error);
    }

    const baseDataDir = await dataDir();
    const attachmentsById = collectAttachmentsById(appData);

    const readLocalFile = async (path: string): Promise<Uint8Array> => {
        if (path.startsWith(baseDataDir)) {
            const relative = path.slice(baseDataDir.length).replace(/^[\\/]/, '');
            return await readFile(relative, { baseDir: BaseDirectory.Data });
        }
        return await readFile(path);
    };

    const localFileExists = async (path: string): Promise<boolean> => {
        try {
            if (path.startsWith(baseDataDir)) {
                const relative = path.slice(baseDataDir.length).replace(/^[\\/]/, '');
                return await exists(relative, { baseDir: BaseDirectory.Data });
            }
            return await exists(path);
        } catch (error) {
            deps.logSyncWarning('Failed to check attachment file', error);
            return false;
        }
    };

    return await syncBasicRemoteAttachments({
        attachmentsById,
        localFileExists,
        onUpload: async (attachment, localPath) => {
            const cloudKey = buildCloudKey(attachment);
            const fileData = await readLocalFile(localPath);
            const validation = await validateAttachmentForUpload(attachment, fileData.length);
            if (!validation.valid) {
                const failure = handleAttachmentValidationFailure(attachment, validation.error);
                reportProgress(attachment.id, 'upload', 0, attachment.size ?? fileData.length, 'failed', failure.message);
                deps.logSyncWarning(
                    failure.reachedLimit
                        ? `${failure.message}; marking attachment unrecoverable`
                        : failure.message,
                );
                return failure.mutated;
            }
            clearAttachmentValidationFailure(attachment.id);
            reportProgress(attachment.id, 'upload', 0, fileData.length, 'active');
            await withRetry(
                () => cloudPutFile(
                    `${baseSyncUrl}/${cloudKey}`,
                    fileData,
                    attachment.mimeType || 'application/octet-stream',
                    {
                        token: cloudConfig.token,
                        fetcher,
                        timeoutMs: UPLOAD_TIMEOUT_MS,
                        onProgress: (loaded, total) => reportProgress(attachment.id, 'upload', loaded, total, 'active'),
                    },
                ),
                {
                    ...CLOUD_ATTACHMENT_RETRY_OPTIONS,
                    onRetry: (error, attempt, delayMs) => {
                        deps.logSyncInfo('Retrying cloud attachment upload', {
                            id: attachment.id,
                            attempt: String(attempt + 1),
                            delayMs: String(delayMs),
                            error: sanitizeLogMessage(error instanceof Error ? error.message : String(error)),
                        });
                    },
                },
            );
            attachment.cloudKey = cloudKey;
            attachment.localStatus = 'available';
            reportProgress(attachment.id, 'upload', fileData.length, fileData.length, 'completed');
            return true;
        },
        onUploadError: (attachment, error) => {
            reportProgress(attachment.id, 'upload', 0, attachment.size ?? 0, 'failed', error instanceof Error ? error.message : String(error));
            deps.logSyncWarning(`Failed to upload attachment ${attachment.title}`, error);
        },
        onDownload: async (attachment) => {
            if (!attachment.cloudKey) return false;
            const fileData = await withRetry(() =>
                cloudGetFile(`${baseSyncUrl}/${attachment.cloudKey}`, {
                    token: cloudConfig.token,
                    fetcher,
                    onProgress: (loaded, total) => reportProgress(attachment.id, 'download', loaded, total, 'active'),
                }),
            );
            const bytes = fileData instanceof ArrayBuffer ? new Uint8Array(fileData) : new Uint8Array(fileData as ArrayBuffer);
            await validateAttachmentHash(attachment, bytes);
            const filename = attachment.cloudKey.split('/').pop() || `${attachment.id}${extractExtension(attachment.uri)}`;
            const relativePath = `${LOCAL_ATTACHMENTS_DIR}/${filename}`;
            await writeAttachmentFileSafely(relativePath, bytes, {
                baseDir: BaseDirectory.Data,
                writeFile,
                rename,
                remove,
            });
            attachment.uri = await join(baseDataDir, relativePath);
            const statusChanged = attachment.localStatus !== 'available';
            if (statusChanged) {
                attachment.localStatus = 'available';
            }
            reportProgress(attachment.id, 'download', bytes.length, bytes.length, 'completed');
            return statusChanged;
        },
        onDownloadError: (attachment, error) => {
            reportProgress(attachment.id, 'download', 0, attachment.size ?? 0, 'failed', error instanceof Error ? error.message : String(error));
            deps.logSyncWarning(`Failed to download attachment ${attachment.title}`, error);
        },
    });
}

export async function syncDropboxAttachments(
    appData: AppData,
    resolveAccessToken: (forceRefresh?: boolean) => Promise<string>,
    deps: AttachmentBackendDeps,
): Promise<boolean> {
    if (!deps.isTauriRuntimeEnv()) return false;

    const fetcher = await deps.getTauriFetch();
    const dropboxFetcher = fetcher ?? fetch;
    const { BaseDirectory, exists, mkdir, readFile, writeFile, rename, remove } = await import('@tauri-apps/plugin-fs');
    const { dataDir, join } = await import('@tauri-apps/api/path');

    try {
        await mkdir(LOCAL_ATTACHMENTS_DIR, { baseDir: BaseDirectory.Data, recursive: true });
    } catch (error) {
        deps.logSyncWarning('Failed to ensure local attachments directory', error);
    }

    const baseDataDir = await dataDir();
    const attachmentsById = collectAttachmentsById(appData);

    const withDropboxAccess = async <T>(operation: (accessToken: string) => Promise<T>): Promise<T> => {
        try {
            return await operation(await resolveAccessToken(false));
        } catch (error) {
            if (error instanceof DropboxUnauthorizedError) {
                return await operation(await resolveAccessToken(true));
            }
            throw error;
        }
    };

    const readLocalFile = async (path: string): Promise<Uint8Array> => {
        if (path.startsWith(baseDataDir)) {
            const relative = path.slice(baseDataDir.length).replace(/^[\\/]/, '');
            return await readFile(relative, { baseDir: BaseDirectory.Data });
        }
        return await readFile(path);
    };

    const localFileExists = async (path: string): Promise<boolean> => {
        try {
            if (path.startsWith(baseDataDir)) {
                const relative = path.slice(baseDataDir.length).replace(/^[\\/]/, '');
                return await exists(relative, { baseDir: BaseDirectory.Data });
            }
            return await exists(path);
        } catch (error) {
            deps.logSyncWarning('Failed to check attachment file', error);
            return false;
        }
    };

    return await syncBasicRemoteAttachments({
        attachmentsById,
        localFileExists,
        onUpload: async (attachment, localPath) => {
            const cloudKey = buildCloudKey(attachment);
            const fileData = await readLocalFile(localPath);
            const validation = await validateAttachmentForUpload(attachment, fileData.length);
            if (!validation.valid) {
                const failure = handleAttachmentValidationFailure(attachment, validation.error);
                reportProgress(attachment.id, 'upload', 0, attachment.size ?? fileData.length, 'failed', failure.message);
                deps.logSyncWarning(
                    failure.reachedLimit
                        ? `${failure.message}; marking attachment unrecoverable`
                        : failure.message,
                );
                return failure.mutated;
            }
            clearAttachmentValidationFailure(attachment.id);
            reportProgress(attachment.id, 'upload', 0, fileData.length, 'active');
            await withRetry(
                () => withDropboxAccess((token) =>
                    uploadDropboxFile(token, cloudKey, fileData, attachment.mimeType || 'application/octet-stream', dropboxFetcher),
                ),
                {
                    ...CLOUD_ATTACHMENT_RETRY_OPTIONS,
                    onRetry: (error, attempt, delayMs) => {
                        deps.logSyncInfo('Retrying Dropbox attachment upload', {
                            id: attachment.id,
                            attempt: String(attempt + 1),
                            delayMs: String(delayMs),
                            error: sanitizeLogMessage(error instanceof Error ? error.message : String(error)),
                        });
                    },
                },
            );
            attachment.cloudKey = cloudKey;
            attachment.localStatus = 'available';
            reportProgress(attachment.id, 'upload', fileData.length, fileData.length, 'completed');
            return true;
        },
        onUploadError: (attachment, error) => {
            reportProgress(attachment.id, 'upload', 0, attachment.size ?? 0, 'failed', error instanceof Error ? error.message : String(error));
            deps.logSyncWarning(`Failed to upload attachment ${attachment.title}`, error);
        },
        onDownload: async (attachment) => {
            if (!attachment.cloudKey) return false;
            reportProgress(attachment.id, 'download', 0, attachment.size ?? 0, 'active');
            let fileData: ArrayBuffer;
            try {
                fileData = await withRetry(() =>
                    withDropboxAccess((token) => downloadDropboxFile(token, attachment.cloudKey!, dropboxFetcher)),
                );
            } catch (error) {
                if (error instanceof DropboxFileNotFoundError) {
                    return markAttachmentUnrecoverable(attachment);
                }
                throw error;
            }
            const bytes = fileData instanceof ArrayBuffer ? new Uint8Array(fileData) : new Uint8Array(fileData as ArrayBuffer);
            await validateAttachmentHash(attachment, bytes);
            const filename = attachment.cloudKey.split('/').pop() || `${attachment.id}${extractExtension(attachment.uri)}`;
            const relativePath = `${LOCAL_ATTACHMENTS_DIR}/${filename}`;
            await writeAttachmentFileSafely(relativePath, bytes, {
                baseDir: BaseDirectory.Data,
                writeFile,
                rename,
                remove,
            });
            attachment.uri = await join(baseDataDir, relativePath);
            const statusChanged = attachment.localStatus !== 'available';
            if (statusChanged) {
                attachment.localStatus = 'available';
            }
            reportProgress(attachment.id, 'download', bytes.length, bytes.length, 'completed');
            return statusChanged;
        },
        onDownloadError: (attachment, error) => {
            reportProgress(attachment.id, 'download', 0, attachment.size ?? 0, 'failed', error instanceof Error ? error.message : String(error));
            deps.logSyncWarning(`Failed to download attachment ${attachment.title}`, error);
        },
    });
}

export async function syncFileAttachments(
    appData: AppData,
    baseSyncDir: string,
    deps: AttachmentBackendDeps,
): Promise<boolean> {
    if (!deps.isTauriRuntimeEnv() || !baseSyncDir) return false;

    const { BaseDirectory, exists, mkdir, readFile, writeFile, rename, remove } = await import('@tauri-apps/plugin-fs');
    const { dataDir, join } = await import('@tauri-apps/api/path');

    const attachmentsDir = await join(baseSyncDir, ATTACHMENTS_DIR_NAME);
    try {
        await mkdir(attachmentsDir, { recursive: true });
    } catch (error) {
        deps.logSyncWarning('Failed to ensure sync attachments directory', error);
    }

    try {
        await mkdir(LOCAL_ATTACHMENTS_DIR, { baseDir: BaseDirectory.Data, recursive: true });
    } catch (error) {
        deps.logSyncWarning('Failed to ensure local attachments directory', error);
    }

    const baseDataDir = await dataDir();
    const attachmentsById = collectAttachmentsById(appData);

    const readLocalFile = async (path: string): Promise<Uint8Array> => {
        if (path.startsWith(baseDataDir)) {
            const relative = path.slice(baseDataDir.length).replace(/^[\\/]/, '');
            return await readFile(relative, { baseDir: BaseDirectory.Data });
        }
        return await readFile(path);
    };

    const localFileExists = async (path: string): Promise<boolean> => {
        try {
            if (path.startsWith(baseDataDir)) {
                const relative = path.slice(baseDataDir.length).replace(/^[\\/]/, '');
                return await exists(relative, { baseDir: BaseDirectory.Data });
            }
            return await exists(path);
        } catch (error) {
            deps.logSyncWarning('Failed to check attachment file', error);
            return false;
        }
    };

    return await syncBasicRemoteAttachments({
        attachmentsById,
        localFileExists,
        onUpload: async (attachment, localPath) => {
            const cloudKey = buildCloudKey(attachment);
            const fileData = await readLocalFile(localPath);
            const validation = await validateAttachmentForUpload(attachment, fileData.length, FILE_BACKEND_VALIDATION_CONFIG);
            if (!validation.valid) {
                const failure = handleAttachmentValidationFailure(attachment, validation.error);
                deps.logSyncWarning(
                    failure.reachedLimit
                        ? `${failure.message}; marking attachment unrecoverable`
                        : failure.message,
                );
                return failure.mutated;
            }
            clearAttachmentValidationFailure(attachment.id);
            await writeFileSafelyAbsolute(await join(baseSyncDir, cloudKey), fileData, {
                writeFile,
                rename,
                remove,
            });
            attachment.cloudKey = cloudKey;
            attachment.localStatus = 'available';
            return true;
        },
        onUploadError: (attachment, error) => {
            deps.logSyncWarning(`Failed to copy attachment ${attachment.title} to sync folder`, error);
        },
        onDownload: async (attachment) => {
            if (!attachment.cloudKey) return false;
            const sourcePath = await join(baseSyncDir, attachment.cloudKey);
            if (!(await exists(sourcePath))) return false;
            const fileData = await readFile(sourcePath);
            await validateAttachmentHash(attachment, fileData);
            const filename = attachment.cloudKey.split('/').pop() || `${attachment.id}${extractExtension(attachment.uri)}`;
            const relativePath = `${LOCAL_ATTACHMENTS_DIR}/${filename}`;
            await writeAttachmentFileSafely(relativePath, fileData, {
                baseDir: BaseDirectory.Data,
                writeFile,
                rename,
                remove,
            });
            attachment.uri = await join(baseDataDir, relativePath);
            const statusChanged = attachment.localStatus !== 'available';
            if (statusChanged) {
                attachment.localStatus = 'available';
            }
            return statusChanged;
        },
        onDownloadError: (attachment, error) => {
            deps.logSyncWarning(`Failed to copy attachment ${attachment.title} from sync folder`, error);
        },
    });
}
