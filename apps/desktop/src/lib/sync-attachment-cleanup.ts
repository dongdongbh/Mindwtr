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
    getSyncPath: () => Promise<string>;
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

const describeAttachmentCleanupErrorForLog = (error: unknown): Error => {
    const status = getErrorStatus(error);
    return new Error(
        status == null
            ? 'Attachment cleanup operation failed'
            : `Attachment cleanup operation failed (${status})`,
    );
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
    try {
        const { remove } = await import('@tauri-apps/plugin-fs');
        const normalizePath = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
        // Same fallback the read paths use: a relocated portable profile leaves
        // the recorded path stale, and the copy it names would otherwise stay in
        // the current managed dir forever (#1038).
        const normalizedRawUri = normalizePath(
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
        logAttachmentCleanupWarning(deps, `Failed to delete attachment file ${attachment.id}`, error);
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
                if (!etag) throw new Error('WebDAV attachment version is unavailable; refusing an unconditional delete');
                guards.ensureLocalSnapshotFresh();
                await guards.assertRemoteMutationFenceHeld?.(35_000);
                await webdavDeleteFileVersioned(targetUrl, etag, {
                    allowInsecureHttp: webdavConfig.allowInsecureHttp,
                    username: webdavConfig.username,
                    password: webdavPassword,
                    fetcher,
                });
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
