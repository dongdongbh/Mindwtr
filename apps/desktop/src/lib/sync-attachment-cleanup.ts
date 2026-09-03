import {
    type AppData,
    type Attachment,
    type AttachmentCleanupRemoteDelete,
    cloudDeleteFile,
    getErrorStatus,
    isSyncRemoteMutationFenceError,
    isWebdavRemoteWriteConflictError,
    sanitizeAttachmentUriForSyncMerge,
    type CloudProvider,
    runAttachmentCleanupLifecycle,
    normalizeStrongWebdavEtag,
    webdavDeleteFile,
    webdavDeleteFileVersioned,
    webdavHeadFile,
} from '@mindwtr/core';

import { resolveAttachmentReadPath } from './attachment-paths';
import {
    deleteDropboxFileVersioned,
    DropboxConflictError,
    DropboxFileNotFoundError,
    DropboxUnauthorizedError,
    getDropboxFileMetadata,
} from './dropbox-sync';
import { getBaseSyncUrl, getCloudBaseUrl } from './sync-attachments';
import type { CloudConfig, WebDavConfig } from './sync-attachment-backends';
import {
    ATTACHMENTS_DIR_NAME,
    createCooperativeYield,
    isTempAttachmentFile,
    stripFileScheme,
    type SyncBackend,
} from './sync-service-utils';
import { getManagedPath } from './managed-paths';

const ATTACHMENT_CLEANUP_BATCH_LIMIT = 25;

export type AttachmentCleanupDeps = {
    getCloudConfig: () => Promise<CloudConfig>;
    getCloudProvider: () => Promise<CloudProvider>;
    getDropboxAccessToken: (clientId: string, options?: { forceRefresh?: boolean }) => Promise<string>;
    getDropboxAppKey: () => Promise<string>;
    getTauriFetch: () => Promise<typeof fetch | undefined>;
    getWebDavConfig: () => Promise<WebDavConfig>;
    isTauriRuntimeEnv: () => boolean;
    logSyncInfo: (message: string, extra?: Record<string, string>) => void;
    logSyncWarning: (message: string, error?: unknown) => void;
    resolveWebdavPassword: (config: WebDavConfig) => Promise<string>;
};

export type AttachmentCleanupGuards = {
    /** Throws LocalSyncAbort when the cleanup snapshot no longer covers the
     * current store. Call immediately before every irreversible delete. */
    ensureLocalSnapshotFresh: () => void;
    assertRemoteMutationFenceHeld?: (minRemainingMs?: number) => Promise<void>;
};

const MAX_APPENDED_CLEANUP_ERROR_CHARS = 300;

// Deliberately not core's sanitizeForLog: that sanitizer keeps a URL's host/path
// (it only strips credentials and flagged query params), while a cleanup cause
// should never carry a server URL at all. Strip URLs and Authorization/Basic
// fragments outright, then cap the length (device test, 2026-09-02).
const sanitizeAttachmentCleanupErrorDetail = (text: string): string => {
    const stripped = text
        .replace(/https?:\/\/\S+/gi, '[url]')
        .replace(/(Authorization:\s*)?(Basic|Bearer)\s+[A-Za-z0-9+/=._-]+/gi, '[redacted]');
    return stripped.length > MAX_APPENDED_CLEANUP_ERROR_CHARS
        ? stripped.slice(0, MAX_APPENDED_CLEANUP_ERROR_CHARS)
        : stripped;
};

const describeAttachmentCleanupErrorForLog = (error: unknown): Error => {
    const status = getErrorStatus(error);
    const prefix = status == null
        ? 'Attachment cleanup operation failed'
        : `Attachment cleanup operation failed (${status})`;
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const sanitizedDetail = sanitizeAttachmentCleanupErrorDetail(detail);
    return new Error(sanitizedDetail ? `${prefix}: ${sanitizedDetail}` : prefix);
};

// Tauri plugin-fs surfaces a missing file as an ENOENT-style io error. Deleting
// an already-gone orphan is the cleanup succeeding, not failing (device test,
// 2026-09-02 logged a warning every cycle for work that was already done).
const isMissingLocalFileError = (error: unknown): boolean => {
    if (!(error instanceof Error)) return false;
    if ((error as Error & { code?: string }).code === 'ENOENT') return true;
    return /no such file or directory|os error 2\b/i.test(error.message);
};

// The path we tried to operate on is the one piece of this error that can carry
// a private attachment title (the on-disk name can equal the title, #1038-era
// paths included) — redact exactly that known substring rather than guessing
// at path shapes in general.
const redactKnownPathFromError = (error: unknown, path: string | undefined): unknown => {
    if (!path || !(error instanceof Error) || !error.message.includes(path)) return error;
    const redacted = new Error(error.message.split(path).join('[attachment-path]'));
    redacted.name = error.name;
    return redacted;
};

const logAttachmentCleanupWarning = (
    deps: Pick<AttachmentCleanupDeps, 'logSyncWarning'>,
    message: string,
    error: unknown,
): void => {
    deps.logSyncWarning(message, describeAttachmentCleanupErrorForLog(error));
};

export const cleanupAttachmentTempFiles = async (deps: Pick<AttachmentCleanupDeps, 'isTauriRuntimeEnv' | 'logSyncWarning'>): Promise<void> => {
    if (!deps.isTauriRuntimeEnv()) return;
    try {
        const { readDir, remove } = await import('@tauri-apps/plugin-fs');
        const attachmentsDir = await getManagedPath(ATTACHMENTS_DIR_NAME);
        const entries = await readDir(attachmentsDir);
        for (const entry of entries) {
            if (!entry.isFile) continue;
            const name = entry.name;
            if (!isTempAttachmentFile(name)) continue;
            try {
                await remove(`${attachmentsDir}/${name}`);
            } catch (error) {
                logAttachmentCleanupWarning(deps, 'Failed to remove temp attachment file', error);
            }
        }
    } catch (error) {
        logAttachmentCleanupWarning(deps, 'Failed to scan temp attachment files', error);
    }
};

export const deleteAttachmentFile = async (
    attachment: Attachment,
    deps: Pick<AttachmentCleanupDeps, 'logSyncWarning'>,
    guards: AttachmentCleanupGuards,
): Promise<void> => {
    const safeUri = sanitizeAttachmentUriForSyncMerge(attachment.uri);
    if (!safeUri) return;
    const rawUri = stripFileScheme(safeUri);
    if (/^https?:\/\//i.test(rawUri) || rawUri.startsWith('content://')) return;
    let normalizedRawUri: string | undefined;
    try {
        const { remove } = await import('@tauri-apps/plugin-fs');
        const normalizePath = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
        // Same fallback the read paths use: a relocated portable profile leaves
        // the recorded path stale, and the copy it names would otherwise stay in
        // the current managed dir forever (#1038).
        normalizedRawUri = normalizePath(
            await resolveAttachmentReadPath(rawUri, attachment.id),
        );
        const normalizedAttachmentsDir = normalizePath(await getManagedPath(ATTACHMENTS_DIR_NAME));
        if (
            normalizedRawUri === normalizedAttachmentsDir
            || !normalizedRawUri.startsWith(`${normalizedAttachmentsDir}/`)
        ) return;
        guards.ensureLocalSnapshotFresh();
        await remove(normalizedRawUri);
    } catch (error) {
        if (error instanceof Error && error.name === 'LocalSyncAbort') throw error;
        if (isMissingLocalFileError(error)) return;
        logAttachmentCleanupWarning(
            deps,
            `Failed to delete attachment file ${attachment.id}`,
            redactKnownPathFromError(error, normalizedRawUri),
        );
    }
};

export const cleanupOrphanedAttachments = async (
    appData: AppData,
    backend: SyncBackend,
    deps: AttachmentCleanupDeps,
    guards: AttachmentCleanupGuards,
): Promise<AppData> => {
    const maybeYield = createCooperativeYield(4);
    const resolveRemoteDeleteAttachment = async (): Promise<AttachmentCleanupRemoteDelete | undefined> => {
        let webdavConfig: WebDavConfig | null = null;
        let cloudConfig: CloudConfig | null = null;
        let cloudProvider: CloudProvider = 'selfhosted';
        let dropboxAppKey = '';

        if (backend === 'webdav') {
            webdavConfig = await deps.getWebDavConfig();
            if (!webdavConfig.url) return undefined;
        } else if (backend === 'cloud') {
            cloudProvider = await deps.getCloudProvider();
            if (cloudProvider === 'dropbox') {
                dropboxAppKey = (await deps.getDropboxAppKey()).trim();
                if (!dropboxAppKey) return undefined;
            } else {
                cloudConfig = await deps.getCloudConfig();
                if (!cloudConfig.url) return undefined;
            }
        } else {
            return undefined;
        }

        const fetcher = await deps.getTauriFetch();
        const dropboxFetcher = fetcher ?? fetch;
        const webdavPassword = webdavConfig ? await deps.resolveWebdavPassword(webdavConfig) : '';
        let dropboxAccessToken: string | null = null;
        const resolveDropboxAccessToken = async (forceRefresh = false): Promise<string> => {
            if (!dropboxAppKey) {
                throw new Error('Dropbox app key is not configured');
            }
            if (!dropboxAccessToken || forceRefresh) {
                dropboxAccessToken = await deps.getDropboxAccessToken(dropboxAppKey, { forceRefresh });
            }
            return dropboxAccessToken;
        };
        const deleteDropboxAttachment = async (cloudKey: string): Promise<void> => {
            const run = async (forceRefresh: boolean) => {
                const token = await resolveDropboxAccessToken(forceRefresh);
                const { rev } = await getDropboxFileMetadata(token, cloudKey, dropboxFetcher);
                if (!rev) throw new DropboxFileNotFoundError('Dropbox file not found');
                guards.ensureLocalSnapshotFresh();
                await guards.assertRemoteMutationFenceHeld?.(35_000);
                await deleteDropboxFileVersioned(token, cloudKey, rev, dropboxFetcher);
            };
            try {
                await run(false);
            } catch (error) {
                if (error instanceof DropboxUnauthorizedError) {
                    await run(true);
                    return;
                }
                throw error;
            }
        };

        return async (target) => {
            if (backend === 'webdav' && webdavConfig?.url) {
                const baseUrl = getBaseSyncUrl(webdavConfig.url);
                const targetUrl = baseUrl + '/' + target.cloudKey;
                const metadata = await webdavHeadFile(targetUrl, {
                    allowInsecureHttp: webdavConfig.allowInsecureHttp,
                    username: webdavConfig.username,
                    password: webdavPassword,
                    fetcher,
                });
                if (!metadata.exists) {
                    const missing = new Error('WebDAV attachment is already missing');
                    (missing as Error & { status?: number }).status = 404;
                    throw missing;
                }
                const etag = normalizeStrongWebdavEtag(metadata.etag);
                guards.ensureLocalSnapshotFresh();
                await guards.assertRemoteMutationFenceHeld?.(35_000);
                const requestOptions = {
                    allowInsecureHttp: webdavConfig.allowInsecureHttp,
                    username: webdavConfig.username,
                    password: webdavPassword,
                    fetcher,
                };
                if (etag) {
                    await webdavDeleteFileVersioned(targetUrl, etag, requestOptions);
                } else {
                    // A server without strong ETags (Jianguoyun, some proxies) gets
                    // the document written unconditionally already; refusing the
                    // delete here only left the orphan on the server and a warning
                    // in the log on every cycle, forever.
                    deps.logSyncInfo('WebDAV attachment removed without a version check; the server provides no strong ETag');
                    await webdavDeleteFile(targetUrl, requestOptions);
                }
            } else if (backend === 'cloud' && cloudProvider === 'selfhosted' && cloudConfig?.url) {
                const baseUrl = getCloudBaseUrl(cloudConfig.url);
                guards.ensureLocalSnapshotFresh();
                await cloudDeleteFile(baseUrl + '/' + target.cloudKey, {
                    allowInsecureHttp: cloudConfig.allowInsecureHttp,
                    token: cloudConfig.token,
                    fetcher,
                });
            } else if (backend === 'cloud' && cloudProvider === 'dropbox') {
                await deleteDropboxAttachment(target.cloudKey);
            }
        };
    };

    const yieldThenEnsureFresh = async (): Promise<void> => {
        await maybeYield();
        guards.ensureLocalSnapshotFresh();
    };

    const result = await runAttachmentCleanupLifecycle({
        appData,
        maxAttachmentTargets: ATTACHMENT_CLEANUP_BATCH_LIMIT,
        beforeEachAttachment: yieldThenEnsureFresh,
        beforeEachRemoteDelete: yieldThenEnsureFresh,
        deleteLocalAttachment: (attachment) => deleteAttachmentFile(attachment, deps, guards),
        resolveRemoteDeleteAttachment,
        // File Sync folders have no distributed GC tombstone. A lagging peer
        // may still reselect any existing generation before its document CAS,
        // so cleanup clears metadata but intentionally retains remote bytes.
        shouldRetainRemoteAttachment: backend === 'file' ? () => true : undefined,
        isRemoteMissingError: (error) => (
            error instanceof DropboxFileNotFoundError || getErrorStatus(error) === 404
        ),
        onRemoteAttachmentMissing: (_target) => {
            deps.logSyncInfo('Remote attachment already missing during cleanup');
        },
        onRemoteDeleteError: (_target, error) => {
            if (
                isSyncRemoteMutationFenceError(error)
                || isWebdavRemoteWriteConflictError(error)
                || error instanceof DropboxConflictError
            ) throw error;
            logAttachmentCleanupWarning(deps, 'Failed to delete remote attachment', error);
        },
        onBatchLimitReached: ({ limit, total }) => {
            deps.logSyncInfo('Attachment cleanup batch limit reached', {
                limit: String(limit),
                total: String(total),
            });
        },
    });

    await cleanupAttachmentTempFiles(deps);
    return result.appData;
};
