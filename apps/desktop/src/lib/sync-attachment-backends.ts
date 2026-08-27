import {
    type AppData,
    type Attachment,
    type AttachmentSettings,
    type SyncRunAttachmentHelpers,
    applyAttachmentPatches,
    withAttachmentSettingsPatch,
    createWebdavDownloadBackoff,
    buildCloudKitAttachmentKey,
    cloudGetFile,
    cloudPutFile,
    computeSha256Hex,
    getErrorStatus,
    isSyncRemoteMutationFenceError,
    isWebdavRemoteWriteConflictError,
    isWebdavRateLimitedError,
    normalizeStrongWebdavEtag,
    parseCloudKitAttachmentKey,
    validateAttachmentForUpload,
    webdavFileExists,
    webdavGetFile,
    webdavHeadFile,
    webdavMakeDirectory,
    webdavPutFileVersioned,
    withRetry,
} from '@mindwtr/core';

import { sanitizeLogMessage } from './app-log';
import {
    collectAttachmentsById,
    createAttachmentUploadSnapshotFactory,
    reportProgress,
    syncBasicRemoteAttachments,
    validateAttachmentHash,
} from './sync-attachments';
import {
    ATTACHMENTS_DIR_NAME,
    buildCloudKey,
    createLocalAttachmentFs,
    extractExtension,
    resolveFileBackendPath,
    sleep,
    stripFileScheme,
    createCooperativeYield,
    writeFileSafelyAbsolute,
} from './sync-service-utils';
import { getManagedPath } from './managed-paths';
import {
    exists as syncFsExists,
    mkdir as syncFsMkdir,
    remove as syncFsRemove,
    rename as syncFsRename,
    stat as syncFsStat,
} from './sync-fs';
import {
    clearAttachmentValidationFailure,
    handleAttachmentValidationFailure,
    markAttachmentUnrecoverable,
} from './sync-attachment-validation';
import { openAttachmentBytes, sealAttachmentBytes } from './sync-encryption-service';
import {
    downloadDropboxFile,
    DropboxConflictError,
    DropboxFileNotFoundError,
    DropboxUnauthorizedError,
    getDropboxFileMetadata,
    uploadDropboxFileVersioned,
} from './dropbox-sync';
import {
    deleteCloudKitAttachmentAssets,
    fetchCloudKitAttachmentAsset,
    saveCloudKitAttachmentAsset,
    type CloudKitAttachmentMetadata,
} from './cloudkit-sync';

export type WebDavConfig = {
    url: string;
    username: string;
    password?: string;
    hasPassword?: boolean;
    allowInsecureHttp?: boolean;
    allowWeakFingerprint?: boolean;
};
export type CloudConfig = {
    url: string;
    token: string;
    allowInsecureHttp?: boolean;
    rememberToken?: boolean;
};

export type AttachmentBackendDeps = {
    getTauriFetch: () => Promise<typeof fetch | undefined>;
    isTauriRuntimeEnv: () => boolean;
    logSyncInfo: (message: string, extra?: Record<string, string>) => void;
    logSyncWarning: (message: string, error?: unknown) => void;
    resolveWebdavPassword: (config: WebDavConfig) => Promise<string>;
};

const FILE_BACKEND_VALIDATION_CONFIG = {
    maxFileSizeBytes: Number.POSITIVE_INFINITY,
    blockedMimeTypes: [],
};
const UPLOAD_TIMEOUT_MS = 120_000;
const WEBDAV_ATTACHMENT_RETRY_OPTIONS = {
    maxAttempts: 5,
    baseDelayMs: 2000,
    maxDelayMs: 60_000,
};
const CLOUD_ATTACHMENT_RETRY_OPTIONS = {
    maxAttempts: 5,
    baseDelayMs: 2000,
    maxDelayMs: 60_000,
};
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
let webdavAttachmentRateLimitedUntil = 0;

export const clearAttachmentSyncState = (): void => {
    webdavDownloadBackoff.clear();
    webdavAttachmentRateLimitedUntil = 0;
};

const getWebdavAttachmentRateLimitRemainingMs = (): number => Math.max(0, webdavAttachmentRateLimitedUntil - Date.now());

const markWebdavAttachmentRateLimited = (
    error: unknown,
    logSyncWarning: AttachmentBackendDeps['logSyncWarning'],
): boolean => {
    if (!isWebdavRateLimitedError(error)) return false;
    webdavAttachmentRateLimitedUntil = Math.max(
        webdavAttachmentRateLimitedUntil,
        Date.now() + WEBDAV_ATTACHMENT_COOLDOWN_MS,
    );
    logSyncWarning('WebDAV rate limited; pausing attachment sync', error);
    return true;
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

/** Which task/project an attachment id belongs to — CloudKit's upload metadata needs the
 *  owner, which the shared lifecycle's per-attachment callbacks don't carry. Deliberately
 *  holds no attachment reference: the attachment values come from the lifecycle's own
 *  working copy, so metadata can never describe a stale pre-patch object. */
type CloudKitAttachmentOwner = {
    ownerType: 'task' | 'project';
    ownerId: string;
};

const collectCloudKitAttachmentOwners = (appData: AppData): Map<string, CloudKitAttachmentOwner> => {
    const owners = new Map<string, CloudKitAttachmentOwner>();
    for (const task of appData.tasks) {
        if (task.deletedAt) continue;
        for (const attachment of task.attachments ?? []) {
            owners.set(attachment.id, { ownerType: 'task', ownerId: task.id });
        }
    }
    for (const project of appData.projects) {
        if (project.deletedAt) continue;
        for (const attachment of project.attachments ?? []) {
            owners.set(attachment.id, { ownerType: 'project', ownerId: project.id });
        }
    }
    return owners;
};

const buildCloudKitAttachmentMetadata = (
    attachment: Attachment,
    owned: CloudKitAttachmentOwner,
    size?: number,
): CloudKitAttachmentMetadata => {
    return {
        attachmentId: attachment.id,
        ownerType: owned.ownerType,
        ownerId: owned.ownerId,
        title: attachment.title || 'attachment',
        mimeType: attachment.mimeType,
        size: Number.isFinite(size ?? NaN) ? size : attachment.size,
        fileHash: attachment.fileHash,
        updatedAt: attachment.updatedAt || new Date().toISOString(),
        deletedAt: attachment.deletedAt,
    };
};

const applyCloudKitAttachmentMetadata = (
    attachment: Attachment,
    metadata: CloudKitAttachmentMetadata,
    fallbackSize?: number,
): boolean => {
    let mutated = false;
    const nextSize = Number.isFinite(metadata.size ?? NaN) ? metadata.size : fallbackSize;
    if (Number.isFinite(nextSize ?? NaN) && attachment.size !== nextSize) {
        attachment.size = nextSize;
        mutated = true;
    }
    if (metadata.fileHash && attachment.fileHash !== metadata.fileHash) {
        attachment.fileHash = metadata.fileHash;
        mutated = true;
    }
    return mutated;
};

/** The next `settings.attachments` value once the flushed keys are dropped, or `undefined`
 *  when there was nothing to flush. Never writes to the input settings. */
const flushPendingCloudKitAttachmentDeletes = async (
    appData: AppData,
): Promise<AttachmentSettings | undefined> => {
    const attachmentSettings = appData.settings.attachments;
    const pendingDeletes = attachmentSettings?.pendingRemoteDeletes ?? [];
    if (!attachmentSettings || pendingDeletes.length === 0) return undefined;

    const remaining = [];
    const recordNames: string[] = [];
    for (const pending of pendingDeletes) {
        const recordName = parseCloudKitAttachmentKey(pending.cloudKey);
        if (recordName) {
            recordNames.push(recordName);
        } else {
            remaining.push(pending);
        }
    }
    if (recordNames.length === 0) return undefined;

    await deleteCloudKitAttachmentAssets(recordNames);
    return { ...attachmentSettings, pendingRemoteDeletes: remaining };
};

export async function syncWebdavAttachments(
    appData: AppData,
    webDavConfig: WebDavConfig,
    baseSyncUrl: string,
    deps: AttachmentBackendDeps,
    helpers?: SyncRunAttachmentHelpers,
): Promise<AppData | null> {
    if (!deps.isTauriRuntimeEnv()) return null;
    if (!webDavConfig.url) return null;
    const cooldownRemainingMs = getWebdavAttachmentRateLimitRemainingMs();
    if (cooldownRemainingMs > 0) {
        deps.logSyncInfo('WebDAV attachment sync skipped during rate-limit cooldown', {
            remainingMs: String(Math.ceil(cooldownRemainingMs)),
        });
        return null;
    }

    const fetcher = await deps.getTauriFetch();
    const { BaseDirectory, exists, mkdir, readFile, stat, writeFile, rename, remove } = await import('@tauri-apps/plugin-fs');
    const { dataDir, join } = await import('@tauri-apps/api/path');
    const password = await deps.resolveWebdavPassword(webDavConfig);

    const attachmentsDirUrl = `${baseSyncUrl}/${ATTACHMENTS_DIR_NAME}`;
    try {
        await helpers?.assertRemoteMutationFenceHeld?.(UPLOAD_TIMEOUT_MS + 5_000);
        await webdavMakeDirectory(attachmentsDirUrl, {
            allowInsecureHttp: webDavConfig.allowInsecureHttp,
            username: webDavConfig.username,
            password,
            fetcher,
        });
    } catch (error) {
        if (isSyncRemoteMutationFenceError(error)) throw error;
        if (markWebdavAttachmentRateLimited(error, deps.logSyncWarning)) {
            return null;
        }
        deps.logSyncWarning('Failed to ensure WebDAV attachments directory', error);
    }

    try {
        await mkdir(await getManagedPath(ATTACHMENTS_DIR_NAME), { recursive: true });
    } catch (error) {
        deps.logSyncWarning('Failed to ensure local attachments directory', error);
    }

    const baseDataDir = await dataDir();
    const managedAttachmentsDir = await getManagedPath(ATTACHMENTS_DIR_NAME);
    const attachmentsById = collectAttachmentsById(appData);
    // Every pass below writes only to per-attachment copies and records them here; the
    // patches are folded into a fresh document at the end. `attachmentsById` is updated
    // alongside so a later pass reads the earlier pass's values (#766: this replaces a
    // full structuredClone of the whole library per cycle).
    const allPatches = new Map<string, Attachment>();
    const recordPatch = (attachment: Attachment): void => {
        allPatches.set(attachment.id, attachment);
        attachmentsById.set(attachment.id, attachment);
    };

    pruneWebdavDownloadBackoff();
    deps.logSyncInfo('WebDAV attachment sync start', {
        count: String(attachmentsById.size),
    });

    let lastRequestAt = 0;
    const waitForSlot = async (): Promise<void> => {
        const cooldownRemainingMs = getWebdavAttachmentRateLimitRemainingMs();
        if (cooldownRemainingMs > 0) {
            throw new Error(`WebDAV rate limited for ${cooldownRemainingMs}ms`);
        }
        const now = Date.now();
        const elapsed = now - lastRequestAt;
        if (elapsed < WEBDAV_ATTACHMENT_MIN_INTERVAL_MS) {
            await sleep(WEBDAV_ATTACHMENT_MIN_INTERVAL_MS - elapsed);
        }
        lastRequestAt = Date.now();
    };
    const handleRateLimit = (error: unknown): boolean => {
        return markWebdavAttachmentRateLimited(error, deps.logSyncWarning);
    };

    const { readLocalFile, localFileExists, statLocalFile } = createLocalAttachmentFs(deps.logSyncWarning, {
        baseDataDir,
        dataBaseDir: BaseDirectory.Data,
        exists,
        readFile,
        managedAttachmentsDir,
        stat,
    });
    const computeLocalFileHash = async (path: string, attachment: Attachment): Promise<string | null> =>
        computeSha256Hex(await readLocalFile(path, attachment));
    const createUploadSnapshot = createAttachmentUploadSnapshotFactory({ readLocalFile, statLocalFile });

    let abortedByRateLimit = false;

    // WebDAV alone verifies that an already-uploaded attachment's remote copy is still there —
    // if it was deleted directly on the server, clear cloudKey so the lifecycle below re-uploads
    // it. This has to run as its own pass before the lifecycle: it's an async, network-calling,
    // state-mutating check, which doesn't fit the lifecycle's synchronous `hasCloudCopy` predicate.
    const maybeYieldPrePass = createCooperativeYield(4);
    for (const attachment of attachmentsById.values()) {
        await maybeYieldPrePass();
        if (attachment.kind !== 'file' || attachment.deletedAt || abortedByRateLimit) continue;

        const rawUri = attachment.uri ? stripFileScheme(attachment.uri) : '';
        const isHttp = /^https?:\/\//i.test(rawUri);
        const localPath = isHttp ? '' : rawUri;
        const hasLocalPath = Boolean(localPath);
        const existsLocally = hasLocalPath
            ? await localFileExists(localPath, attachment)
            : false;
        deps.logSyncInfo('WebDAV attachment check', {
            id: attachment.id,
            title: attachment.title || 'attachment',
            uri: localPath || rawUri,
            cloud: attachment.cloudKey ? 'set' : 'missing',
            local: hasLocalPath ? 'true' : 'false',
            exists: existsLocally ? 'true' : 'false',
        });

        if (existsLocally) {
            webdavDownloadBackoff.deleteEntry(attachment.id);
        }

        if (attachment.cloudKey && existsLocally && attachment.pendingContentUpload !== true) {
            try {
                const remoteExists = await withRetry(async () => {
                    await waitForSlot();
                    return await webdavFileExists(`${baseSyncUrl}/${attachment.cloudKey}`, {
                        allowInsecureHttp: webDavConfig.allowInsecureHttp,
                        username: webDavConfig.username,
                        password,
                        fetcher,
                    });
                }, WEBDAV_ATTACHMENT_RETRY_OPTIONS);
                deps.logSyncInfo('WebDAV attachment remote exists', {
                    id: attachment.id,
                    exists: remoteExists ? 'true' : 'false',
                });
                if (!remoteExists) {
                    recordPatch({ ...attachment, cloudKey: undefined });
                }
            } catch (error) {
                if (handleRateLimit(error)) {
                    abortedByRateLimit = true;
                    break;
                }
                deps.logSyncWarning('Failed to check WebDAV attachment remote status', error);
            }
        }
    }

    // Throttle policy: per-run upload/download caps, plus the same rate-limit abort the pre-pass
    // above already tripped. Passed to the shared lifecycle as optional `policy` hooks (default
    // off for every other backend) so the caps/backoff live in one place other backends can reuse.
    let uploadCount = 0;
    let uploadLimitLogged = false;
    let downloadCount = 0;
    let downloadLimitLogged = false;

    const shouldUpload = (): boolean => {
        if (uploadCount >= WEBDAV_ATTACHMENT_MAX_UPLOADS_PER_SYNC) {
            if (!uploadLimitLogged) {
                deps.logSyncInfo('WebDAV attachment upload limit reached', {
                    limit: String(WEBDAV_ATTACHMENT_MAX_UPLOADS_PER_SYNC),
                });
                uploadLimitLogged = true;
            }
            return false;
        }
        uploadCount += 1;
        return true;
    };

    const shouldDownload = (attachment: Attachment): boolean => {
        if (getWebdavDownloadBackoff(attachment.id)) return false;
        if (downloadCount >= WEBDAV_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC) {
            if (!downloadLimitLogged) {
                deps.logSyncInfo('WebDAV attachment download limit reached', {
                    limit: String(WEBDAV_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC),
                });
                downloadLimitLogged = true;
            }
            return false;
        }
        downloadCount += 1;
        return true;
    };

    const { patches } = await syncBasicRemoteAttachments({
        attachmentsById,
        deferUploads: helpers?.phase === 'prepare',
        ensureLocalSnapshotFresh: helpers?.ensureLocalSnapshotFresh,
        localFileExists,
        getLocalFileStat: statLocalFile,
        computeLocalFileHash,
        createUploadSnapshot,
        contentChangePhase: helpers?.phase,
        isFatalError: (error) => (
            isSyncRemoteMutationFenceError(error)
            || isWebdavRemoteWriteConflictError(error)
        ),
        policy: {
            shouldSkip: () => abortedByRateLimit,
            shouldUpload,
            shouldDownload,
        },
        onUpload: async (attachment, _localPath, snapshot) => {
            const cloudKey = buildCloudKey(attachment);
            if (!snapshot?.bytes) throw new Error('Immutable attachment upload bytes are unavailable');
            const fileData = snapshot.bytes;
            const validation = await validateAttachmentForUpload(attachment, fileData.length);
            if (!validation.valid) {
                const failure = handleAttachmentValidationFailure(attachment, validation.error);
                reportProgress(
                    attachment.id,
                    'upload',
                    0,
                    attachment.size ?? fileData.length,
                    'failed',
                    failure.message,
                );
                deps.logSyncWarning(
                    failure.reachedLimit ? `${failure.message}; marking attachment unrecoverable` : failure.message,
                );
                return failure.mutated;
            }
            clearAttachmentValidationFailure(attachment.id);
            reportProgress(attachment.id, 'upload', 0, fileData.length, 'active');
            deps.logSyncInfo('WebDAV attachment upload start', {
                id: attachment.id,
                bytes: String(fileData.length),
                cloudKey,
            });
            // Encrypted bytes keep the attachment's exact remote name (cloudKey is identity-
            // keyed and immutable once uploaded), but they are longer than the plaintext — the
            // Content-Length header has to describe what actually goes on the wire.
            const wireData = await sealAttachmentBytes(fileData);
            const uploadUrl = `${baseSyncUrl}/${cloudKey}`;
            const remoteVersion = await withRetry(async () => {
                await waitForSlot();
                return webdavHeadFile(uploadUrl, {
                    allowInsecureHttp: webDavConfig.allowInsecureHttp,
                    username: webDavConfig.username,
                    password,
                    fetcher,
                    timeoutMs: UPLOAD_TIMEOUT_MS,
                });
            }, WEBDAV_ATTACHMENT_RETRY_OPTIONS);
            const expectedEtag = remoteVersion.exists
                ? normalizeStrongWebdavEtag(remoteVersion.etag)
                : null;
            if (remoteVersion.exists && !expectedEtag) {
                throw new Error('WebDAV attachment version is unavailable; refusing an unconditional overwrite');
            }
            await withRetry(
                async () => {
                    await waitForSlot();
                    await helpers?.assertRemoteMutationFenceHeld?.(UPLOAD_TIMEOUT_MS + 5_000);
                    return await webdavPutFileVersioned(
                        uploadUrl,
                        wireData,
                        attachment.mimeType || 'application/octet-stream',
                        expectedEtag,
                        {
                            allowInsecureHttp: webDavConfig.allowInsecureHttp,
                            headers: { 'Content-Length': String(wireData.length) },
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
            reportProgress(attachment.id, 'upload', fileData.length, fileData.length, 'completed');
            deps.logSyncInfo('WebDAV attachment upload done', {
                id: attachment.id,
                bytes: String(fileData.length),
            });
            return true;
        },
        onUploadError: (attachment, error) => {
            if (handleRateLimit(error)) {
                abortedByRateLimit = true;
                return;
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
        },
        onDownload: async (attachment) => {
            if (!attachment.cloudKey) return false;
            const cloudKey = attachment.cloudKey;
            let fileData: ArrayBuffer;
            try {
                fileData = await withRetry(async () => {
                    await waitForSlot();
                    return await webdavGetFile(`${baseSyncUrl}/${cloudKey}`, {
                        allowInsecureHttp: webDavConfig.allowInsecureHttp,
                        username: webDavConfig.username,
                        password,
                        fetcher,
                        onProgress: (loaded, total) =>
                            reportProgress(attachment.id, 'download', loaded, total, 'active'),
                    });
                }, WEBDAV_ATTACHMENT_RETRY_OPTIONS);
            } catch (error) {
                if (handleRateLimit(error)) {
                    abortedByRateLimit = true;
                    return false;
                }
                if (getErrorStatus(error) === 404) {
                    webdavDownloadBackoff.deleteEntry(attachment.id);
                    const mutated = markAttachmentUnrecoverable(attachment);
                    deps.logSyncInfo('Cleared missing WebDAV cloud key after 404', { id: attachment.id });
                    return mutated;
                }
                throw error;
            }
            // Decrypt before the hash check: fileHash is a plaintext-domain value inside the
            // synced document, and it must stay stable across re-encryptions.
            const bytes = await openAttachmentBytes(
                fileData instanceof ArrayBuffer ? new Uint8Array(fileData) : new Uint8Array(fileData as ArrayBuffer),
            );
            await validateAttachmentHash(attachment, bytes);
            const filename = cloudKey.split('/').pop() || `${attachment.id}${extractExtension(attachment.uri)}`;
            const targetPath = await join(managedAttachmentsDir, filename);
            await writeFileSafelyAbsolute(targetPath, bytes, {
                writeFile,
                rename,
                remove,
            });
            attachment.uri = targetPath;
            const statusChanged = attachment.localStatus !== 'available';
            if (statusChanged) {
                attachment.localStatus = 'available';
            }
            webdavDownloadBackoff.deleteEntry(attachment.id);
            reportProgress(attachment.id, 'download', bytes.length, bytes.length, 'completed');
            return statusChanged;
        },
        onDownloadError: (attachment, error) => {
            // Rate-limit and 404 are handled inside onDownload's own try/catch above, since only
            // onDownload's return value can signal a mutation back to the lifecycle. Only "other"
            // (retry-exhausted / hash-validation / write) errors reach here.
            setWebdavDownloadBackoff(attachment.id, error);
            reportProgress(
                attachment.id,
                'download',
                0,
                attachment.size ?? 0,
                'failed',
                error instanceof Error ? error.message : String(error),
            );
            deps.logSyncWarning(`Failed to download attachment ${attachment.title}`, error);
        },
    });

    for (const patch of patches.values()) allPatches.set(patch.id, patch);
    const nextData = applyAttachmentPatches(appData, allPatches);
    const didMutate = nextData !== appData;

    if (abortedByRateLimit) {
        deps.logSyncWarning('WebDAV attachment sync aborted due to rate limiting');
    }
    deps.logSyncInfo('WebDAV attachment sync done', {
        mutated: didMutate ? 'true' : 'false',
    });
    return didMutate ? nextData : null;
}

export async function syncCloudAttachments(
    appData: AppData,
    cloudConfig: CloudConfig,
    baseSyncUrl: string,
    deps: AttachmentBackendDeps,
    helpers?: SyncRunAttachmentHelpers,
): Promise<AppData | false> {
    if (!deps.isTauriRuntimeEnv() || !cloudConfig.url) return false;

    const fetcher = await deps.getTauriFetch();
    const { BaseDirectory, exists, mkdir, readFile, stat, writeFile, rename, remove } = await import('@tauri-apps/plugin-fs');
    const { dataDir, join } = await import('@tauri-apps/api/path');

    try {
        await mkdir(await getManagedPath(ATTACHMENTS_DIR_NAME), { recursive: true });
    } catch (error) {
        deps.logSyncWarning('Failed to ensure local attachments directory', error);
    }

    const baseDataDir = await dataDir();
    const managedAttachmentsDir = await getManagedPath(ATTACHMENTS_DIR_NAME);
    const attachmentsById = collectAttachmentsById(appData);

    const { readLocalFile, localFileExists, statLocalFile } = createLocalAttachmentFs(deps.logSyncWarning, {
        baseDataDir,
        dataBaseDir: BaseDirectory.Data,
        exists,
        readFile,
        managedAttachmentsDir,
        stat,
    });
    const computeLocalFileHash = async (path: string, attachment: Attachment): Promise<string | null> =>
        computeSha256Hex(await readLocalFile(path, attachment));
    const createUploadSnapshot = createAttachmentUploadSnapshotFactory({ readLocalFile, statLocalFile });

    const { patches } = await syncBasicRemoteAttachments({
        attachmentsById,
        deferUploads: helpers?.phase === 'prepare',
        ensureLocalSnapshotFresh: helpers?.ensureLocalSnapshotFresh,
        localFileExists,
        getLocalFileStat: statLocalFile,
        computeLocalFileHash,
        createUploadSnapshot,
        contentChangePhase: helpers?.phase,
        isFatalError: isSyncRemoteMutationFenceError,
        onUpload: async (attachment, _localPath, snapshot) => {
            const cloudKey = buildCloudKey(attachment);
            if (!snapshot?.bytes) throw new Error('Immutable attachment upload bytes are unavailable');
            const fileData = snapshot.bytes;
            const validation = await validateAttachmentForUpload(attachment, fileData.length);
            if (!validation.valid) {
                const failure = handleAttachmentValidationFailure(attachment, validation.error);
                reportProgress(
                    attachment.id,
                    'upload',
                    0,
                    attachment.size ?? fileData.length,
                    'failed',
                    failure.message,
                );
                deps.logSyncWarning(
                    failure.reachedLimit ? `${failure.message}; marking attachment unrecoverable` : failure.message,
                );
                return failure.mutated;
            }
            clearAttachmentValidationFailure(attachment.id);
            reportProgress(attachment.id, 'upload', 0, fileData.length, 'active');
            await withRetry(
                async () => {
                    await helpers?.assertRemoteMutationFenceHeld?.(UPLOAD_TIMEOUT_MS + 5_000);
                    return await cloudPutFile(
                        `${baseSyncUrl}/${cloudKey}`,
                        fileData,
                        attachment.mimeType || 'application/octet-stream',
                        {
                            allowInsecureHttp: cloudConfig.allowInsecureHttp,
                            token: cloudConfig.token,
                            fetcher,
                            timeoutMs: UPLOAD_TIMEOUT_MS,
                            onProgress: (loaded, total) =>
                                reportProgress(attachment.id, 'upload', loaded, total, 'active'),
                        },
                    );
                },
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
            reportProgress(
                attachment.id,
                'upload',
                0,
                attachment.size ?? 0,
                'failed',
                error instanceof Error ? error.message : String(error),
            );
            deps.logSyncWarning(`Failed to upload attachment ${attachment.title}`, error);
        },
        onDownload: async (attachment) => {
            if (!attachment.cloudKey) return false;
            let fileData: ArrayBuffer;
            try {
                fileData = await withRetry(() =>
                    cloudGetFile(`${baseSyncUrl}/${attachment.cloudKey}`, {
                        allowInsecureHttp: cloudConfig.allowInsecureHttp,
                        token: cloudConfig.token,
                        fetcher,
                        onProgress: (loaded, total) =>
                            reportProgress(attachment.id, 'download', loaded, total, 'active'),
                    }),
                );
            } catch (error) {
                if (getErrorStatus(error) === 404) {
                    return markAttachmentUnrecoverable(attachment);
                }
                throw error;
            }
            const bytes =
                fileData instanceof ArrayBuffer ? new Uint8Array(fileData) : new Uint8Array(fileData as ArrayBuffer);
            await validateAttachmentHash(attachment, bytes);
            const filename =
                attachment.cloudKey.split('/').pop() || `${attachment.id}${extractExtension(attachment.uri)}`;
            const targetPath = await join(managedAttachmentsDir, filename);
            await writeFileSafelyAbsolute(targetPath, bytes, {
                writeFile,
                rename,
                remove,
            });
            attachment.uri = targetPath;
            const statusChanged = attachment.localStatus !== 'available';
            if (statusChanged) {
                attachment.localStatus = 'available';
            }
            reportProgress(attachment.id, 'download', bytes.length, bytes.length, 'completed');
            return statusChanged;
        },
        onDownloadError: (attachment, error) => {
            reportProgress(
                attachment.id,
                'download',
                0,
                attachment.size ?? 0,
                'failed',
                error instanceof Error ? error.message : String(error),
            );
            deps.logSyncWarning(`Failed to download attachment ${attachment.title}`, error);
        },
    });

    const nextData = applyAttachmentPatches(appData, patches);
    return nextData !== appData ? nextData : false;
}

export async function syncDropboxAttachments(
    appData: AppData,
    resolveAccessToken: (forceRefresh?: boolean) => Promise<string>,
    deps: AttachmentBackendDeps,
    helpers?: SyncRunAttachmentHelpers,
): Promise<AppData | false> {
    if (!deps.isTauriRuntimeEnv()) return false;

    const fetcher = await deps.getTauriFetch();
    const dropboxFetcher = fetcher ?? fetch;
    const { BaseDirectory, exists, mkdir, readFile, stat, writeFile, rename, remove } = await import('@tauri-apps/plugin-fs');
    const { dataDir, join } = await import('@tauri-apps/api/path');

    try {
        await mkdir(await getManagedPath(ATTACHMENTS_DIR_NAME), { recursive: true });
    } catch (error) {
        deps.logSyncWarning('Failed to ensure local attachments directory', error);
    }

    const baseDataDir = await dataDir();
    const managedAttachmentsDir = await getManagedPath(ATTACHMENTS_DIR_NAME);
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

    const { readLocalFile, localFileExists, statLocalFile } = createLocalAttachmentFs(deps.logSyncWarning, {
        baseDataDir,
        dataBaseDir: BaseDirectory.Data,
        exists,
        readFile,
        managedAttachmentsDir,
        stat,
    });
    const computeLocalFileHash = async (path: string, attachment: Attachment): Promise<string | null> =>
        computeSha256Hex(await readLocalFile(path, attachment));
    const createUploadSnapshot = createAttachmentUploadSnapshotFactory({ readLocalFile, statLocalFile });

    const { patches } = await syncBasicRemoteAttachments({
        attachmentsById,
        deferUploads: helpers?.phase === 'prepare',
        ensureLocalSnapshotFresh: helpers?.ensureLocalSnapshotFresh,
        localFileExists,
        getLocalFileStat: statLocalFile,
        computeLocalFileHash,
        createUploadSnapshot,
        contentChangePhase: helpers?.phase,
        isFatalError: (error) => (
            isSyncRemoteMutationFenceError(error)
            || error instanceof DropboxConflictError
        ),
        onUpload: async (attachment, _localPath, snapshot) => {
            const cloudKey = buildCloudKey(attachment);
            if (!snapshot?.bytes) throw new Error('Immutable attachment upload bytes are unavailable');
            const fileData = snapshot.bytes;
            const validation = await validateAttachmentForUpload(attachment, fileData.length);
            if (!validation.valid) {
                const failure = handleAttachmentValidationFailure(attachment, validation.error);
                reportProgress(
                    attachment.id,
                    'upload',
                    0,
                    attachment.size ?? fileData.length,
                    'failed',
                    failure.message,
                );
                deps.logSyncWarning(
                    failure.reachedLimit ? `${failure.message}; marking attachment unrecoverable` : failure.message,
                );
                return failure.mutated;
            }
            clearAttachmentValidationFailure(attachment.id);
            reportProgress(attachment.id, 'upload', 0, fileData.length, 'active');
            const wireData = await sealAttachmentBytes(fileData);
            const expectedRev = await withRetry(
                () => withDropboxAccess((token) => getDropboxFileMetadata(
                    token,
                    cloudKey,
                    dropboxFetcher,
                    { timeoutMs: UPLOAD_TIMEOUT_MS },
                )),
                CLOUD_ATTACHMENT_RETRY_OPTIONS,
            ).then((metadata) => metadata.rev);
            await withRetry(
                () =>
                    withDropboxAccess(async (token) => {
                        await helpers?.assertRemoteMutationFenceHeld?.(UPLOAD_TIMEOUT_MS + 5_000);
                        return uploadDropboxFileVersioned(
                            token,
                            cloudKey,
                            wireData,
                            expectedRev,
                            dropboxFetcher,
                            { timeoutMs: UPLOAD_TIMEOUT_MS },
                        );
                    }),
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
            reportProgress(
                attachment.id,
                'upload',
                0,
                attachment.size ?? 0,
                'failed',
                error instanceof Error ? error.message : String(error),
            );
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
            const bytes = await openAttachmentBytes(
                fileData instanceof ArrayBuffer ? new Uint8Array(fileData) : new Uint8Array(fileData as ArrayBuffer),
            );
            await validateAttachmentHash(attachment, bytes);
            const filename =
                attachment.cloudKey.split('/').pop() || `${attachment.id}${extractExtension(attachment.uri)}`;
            const targetPath = await join(managedAttachmentsDir, filename);
            await writeFileSafelyAbsolute(targetPath, bytes, {
                writeFile,
                rename,
                remove,
            });
            attachment.uri = targetPath;
            const statusChanged = attachment.localStatus !== 'available';
            if (statusChanged) {
                attachment.localStatus = 'available';
            }
            reportProgress(attachment.id, 'download', bytes.length, bytes.length, 'completed');
            return statusChanged;
        },
        onDownloadError: (attachment, error) => {
            reportProgress(
                attachment.id,
                'download',
                0,
                attachment.size ?? 0,
                'failed',
                error instanceof Error ? error.message : String(error),
            );
            deps.logSyncWarning(`Failed to download attachment ${attachment.title}`, error);
        },
    });

    const nextData = applyAttachmentPatches(appData, patches);
    return nextData !== appData ? nextData : false;
}

export async function syncCloudKitAttachments(
    appData: AppData,
    deps: AttachmentBackendDeps,
    helpers?: SyncRunAttachmentHelpers,
): Promise<AppData | false> {
    if (!deps.isTauriRuntimeEnv()) return false;

    const { BaseDirectory, exists, mkdir, readFile, stat, writeFile, rename, remove } = await import('@tauri-apps/plugin-fs');
    const { dataDir, join } = await import('@tauri-apps/api/path');

    try {
        await mkdir(await getManagedPath(ATTACHMENTS_DIR_NAME), { recursive: true });
    } catch (error) {
        deps.logSyncWarning('Failed to ensure CloudKit attachments directory', error);
    }

    const baseDataDir = await dataDir();
    const managedAttachmentsDir = await getManagedPath(ATTACHMENTS_DIR_NAME);
    const attachmentsById = collectAttachmentsById(appData);
    const ownerByAttachmentId = collectCloudKitAttachmentOwners(appData);
    const settingsPatch = await flushPendingCloudKitAttachmentDeletes(appData);

    const { readLocalFile, localFileExists, statLocalFile } = createLocalAttachmentFs(
        deps.logSyncWarning,
        { baseDataDir, dataBaseDir: BaseDirectory.Data, exists, readFile, managedAttachmentsDir, stat },
        'Failed to check CloudKit attachment file',
    );
    const computeLocalFileHash = async (path: string, attachment: Attachment): Promise<string | null> =>
        computeSha256Hex(await readLocalFile(path, attachment));
    const createUploadSnapshot = createAttachmentUploadSnapshotFactory({
        readLocalFile,
        statLocalFile,
        stageBytes: async (bytes, attachment) => {
            const sourcePath = await join(
                managedAttachmentsDir,
                `.upload-${attachment.id}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
            );
            await writeFileSafelyAbsolute(sourcePath, bytes, { writeFile, rename, remove });
            return {
                sourcePath,
                dispose: async () => {
                    await remove(sourcePath);
                },
            };
        },
    });

    deps.logSyncInfo('CloudKit attachment sync start', {
        count: String(attachmentsById.size),
    });

    const { patches } = await syncBasicRemoteAttachments({
        attachmentsById,
        deferUploads: helpers?.phase === 'prepare',
        ensureLocalSnapshotFresh: helpers?.ensureLocalSnapshotFresh,
        localFileExists,
        getLocalFileStat: statLocalFile,
        computeLocalFileHash,
        createUploadSnapshot,
        contentChangePhase: helpers?.phase,
        // A cloudKey written by a different backend before a provider switch isn't a valid
        // CloudKit record key, so CloudKit must still treat the attachment as needing upload.
        hasCloudCopy: (attachment) => Boolean(parseCloudKitAttachmentKey(attachment.cloudKey)),
        onUpload: async (attachment, localPath, snapshot) => {
            const owned = ownerByAttachmentId.get(attachment.id);
            if (!owned) return false;
            if (!snapshot?.bytes) throw new Error('Immutable attachment upload bytes are unavailable');
            const fileData = snapshot.bytes;
            const validation = await validateAttachmentForUpload(attachment, fileData.length);
            if (!validation.valid) {
                const failure = handleAttachmentValidationFailure(attachment, validation.error);
                reportProgress(
                    attachment.id,
                    'upload',
                    0,
                    attachment.size ?? fileData.length,
                    'failed',
                    failure.message,
                );
                deps.logSyncWarning(failure.message, validation.error);
                return failure.mutated;
            }

            clearAttachmentValidationFailure(attachment.id);
            reportProgress(attachment.id, 'upload', 0, fileData.length, 'active');
            const metadata = buildCloudKitAttachmentMetadata(
                { ...attachment, fileHash: snapshot.fileHash },
                owned,
                fileData.length,
            );
            const savedMetadata = await saveCloudKitAttachmentAsset(attachment.id, localPath, metadata);
            attachment.cloudKey = buildCloudKitAttachmentKey(attachment.id);
            attachment.localStatus = 'available';
            applyCloudKitAttachmentMetadata(attachment, savedMetadata, fileData.length);
            reportProgress(attachment.id, 'upload', fileData.length, fileData.length, 'completed');
            return true;
        },
        onUploadError: (attachment, error) => {
            reportProgress(
                attachment.id,
                'upload',
                0,
                attachment.size ?? 0,
                'failed',
                error instanceof Error ? error.message : String(error),
            );
            deps.logSyncWarning(`Failed to upload CloudKit attachment ${attachment.title}`, error);
        },
        onDownload: async (attachment) => {
            const recordName = parseCloudKitAttachmentKey(attachment.cloudKey);
            if (!recordName) return false;
            const extension = extractExtension(attachment.title) || extractExtension(attachment.uri);
            const filename = `${attachment.id}${extension}`;
            const targetPath = await join(managedAttachmentsDir, filename);
            reportProgress(attachment.id, 'download', 0, attachment.size ?? 0, 'active');
            const metadata = await fetchCloudKitAttachmentAsset(recordName, targetPath);
            const bytes = await readFile(targetPath);
            await validateAttachmentHash(attachment, bytes);
            attachment.uri = targetPath;
            attachment.localStatus = 'available';
            applyCloudKitAttachmentMetadata(attachment, metadata, bytes.length);
            reportProgress(attachment.id, 'download', bytes.length, bytes.length, 'completed');
            return true;
        },
        onDownloadError: (attachment, error) => {
            reportProgress(
                attachment.id,
                'download',
                0,
                attachment.size ?? 0,
                'failed',
                error instanceof Error ? error.message : String(error),
            );
            deps.logSyncWarning(`Failed to download CloudKit attachment ${attachment.title}`, error);
        },
    });

    const nextData = withAttachmentSettingsPatch(applyAttachmentPatches(appData, patches), settingsPatch);
    const didMutate = nextData !== appData;
    deps.logSyncInfo('CloudKit attachment sync done', {
        mutated: didMutate ? 'true' : 'false',
    });

    return didMutate ? nextData : false;
}

export async function syncFileAttachments(
    appData: AppData,
    baseSyncDir: string,
    deps: AttachmentBackendDeps,
    helpers?: SyncRunAttachmentHelpers,
): Promise<AppData | false> {
    if (!deps.isTauriRuntimeEnv() || !baseSyncDir) return false;

    // #1037: every fs call below can land on the sync folder, which may be a
    // slow mount, so the ones the plugin runs on the main thread come from
    // ./sync-fs instead. The plugin's own readFile/writeFile are already async.
    const { BaseDirectory, exists, readFile, stat, writeFile } = await import('@tauri-apps/plugin-fs');
    const { dataDir, join } = await import('@tauri-apps/api/path');

    const attachmentsDir = await join(baseSyncDir, ATTACHMENTS_DIR_NAME);
    try {
        await syncFsMkdir(attachmentsDir);
    } catch (error) {
        deps.logSyncWarning('Failed to ensure sync attachments directory', error);
    }

    try {
        await syncFsMkdir(await getManagedPath(ATTACHMENTS_DIR_NAME));
    } catch (error) {
        deps.logSyncWarning('Failed to ensure local attachments directory', error);
    }

    const baseDataDir = await dataDir();
    const managedAttachmentsDir = await getManagedPath(ATTACHMENTS_DIR_NAME);
    const attachmentsById = collectAttachmentsById(appData);

    const { readLocalFile, localFileExists, statLocalFile } = createLocalAttachmentFs(deps.logSyncWarning, {
        baseDataDir,
        dataBaseDir: BaseDirectory.Data,
        // An absolute attachment uri can point at the slow mount too; only the
        // base-directory-relative branch is guaranteed to be local app data.
        exists: (path, options) => (options ? exists(path, options) : syncFsExists(path)),
        readFile,
        managedAttachmentsDir,
        // Same #1037 risk as `exists` above — the fs plugin's `stat` is main-thread
        // too (review S5), so a non-managed-dir path goes through the async Rust
        // command instead.
        stat: async (path, options) => {
            if (options) return stat(path, options);
            const result = await syncFsStat(path);
            return { mtime: new Date(result.mtimeMs), size: result.size };
        },
    });
    const computeLocalFileHash = async (path: string, attachment: Attachment): Promise<string | null> =>
        computeSha256Hex(await readLocalFile(path, attachment));
    const createUploadSnapshot = createAttachmentUploadSnapshotFactory({ readLocalFile, statLocalFile });

    // Mirror the WebDAV presence pre-pass: a cloudKey recorded against a
    // previous sync folder (or a file deleted from this one) must not stop
    // the copy into the current folder. Clearing it lets the lifecycle below
    // re-upload; only cleared when a local copy exists to upload from (#1001).
    const allPatches = new Map<string, Attachment>();
    for (const attachment of attachmentsById.values()) {
        if (
            attachment.kind !== 'file'
            || attachment.deletedAt
            || !attachment.cloudKey
            || attachment.pendingContentUpload === true
        ) continue;
        const rawUri = attachment.uri ? stripFileScheme(attachment.uri) : '';
        if (!rawUri || /^https?:\/\//i.test(rawUri)) continue;
        if (!(await localFileExists(rawUri, attachment))) continue;
        try {
            const remotePath = await resolveFileBackendPath(join, baseSyncDir, attachment.cloudKey);
            if (!(await syncFsExists(remotePath))) {
                const patched: Attachment = { ...attachment, cloudKey: undefined };
                allPatches.set(patched.id, patched);
                attachmentsById.set(patched.id, patched);
            }
        } catch (error) {
            deps.logSyncWarning('Failed to check sync-folder attachment presence', error);
        }
    }

    const { patches } = await syncBasicRemoteAttachments({
        attachmentsById,
        deferUploads: helpers?.phase === 'prepare',
        ensureLocalSnapshotFresh: helpers?.ensureLocalSnapshotFresh,
        localFileExists,
        getLocalFileStat: statLocalFile,
        computeLocalFileHash,
        createUploadSnapshot,
        contentChangePhase: helpers?.phase,
        onUpload: async (attachment, _localPath, snapshot) => {
            const cloudKey = buildCloudKey(attachment);
            if (!snapshot?.bytes) throw new Error('Immutable attachment upload bytes are unavailable');
            const fileData = snapshot.bytes;
            const validation = await validateAttachmentForUpload(
                attachment,
                fileData.length,
                FILE_BACKEND_VALIDATION_CONFIG,
            );
            if (!validation.valid) {
                const failure = handleAttachmentValidationFailure(attachment, validation.error);
                deps.logSyncWarning(
                    failure.reachedLimit ? `${failure.message}; marking attachment unrecoverable` : failure.message,
                );
                return failure.mutated;
            }
            clearAttachmentValidationFailure(attachment.id);
            // The sync folder is the remote for this backend, so its attachment bytes are
            // encrypted here for the same reason WebDAV's and Dropbox's are. The LOCAL managed
            // copy (below, in onDownload) stays plaintext — encryption never touches local data.
            const wireData = await sealAttachmentBytes(fileData);
            await writeFileSafelyAbsolute(await resolveFileBackendPath(join, baseSyncDir, cloudKey), wireData, {
                writeFile,
                rename: syncFsRename,
                remove: syncFsRemove,
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
            const sourcePath = await resolveFileBackendPath(join, baseSyncDir, attachment.cloudKey);
            if (!(await syncFsExists(sourcePath))) return false;
            const fileData = await openAttachmentBytes(await readFile(sourcePath));
            await validateAttachmentHash(attachment, fileData);
            const filename =
                attachment.cloudKey.split('/').pop() || `${attachment.id}${extractExtension(attachment.uri)}`;
            const targetPath = await join(managedAttachmentsDir, filename);
            await writeFileSafelyAbsolute(targetPath, fileData, {
                writeFile,
                rename: syncFsRename,
                remove: syncFsRemove,
            });
            attachment.uri = targetPath;
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

    for (const patch of patches.values()) allPatches.set(patch.id, patch);
    const nextData = applyAttachmentPatches(appData, allPatches);
    return nextData !== appData ? nextData : false;
}
