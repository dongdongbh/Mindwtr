import {
    type AppData,
    type Attachment,
    type AttachmentCleanupRemoteDelete,
    cloudDeleteFile,
    LEGACY_SYNC_FILE_NAME,
    sanitizeAttachmentUriForSyncMerge,
    type CloudProvider,
    runAttachmentCleanupLifecycle,
    SYNC_FILE_NAME,
    webdavDeleteFile,
} from '@mindwtr/core';

import { resolveAttachmentReadPath } from './attachment-paths';
import { deleteDropboxFile, DropboxFileNotFoundError, DropboxUnauthorizedError } from './dropbox-sync';
import { getBaseSyncUrl, getCloudBaseUrl } from './sync-attachments';
import type { CloudConfig, WebDavConfig } from './sync-attachment-backends';
import {
    ATTACHMENTS_DIR_NAME,
    createCooperativeYield,
    getFileSyncDir,
    isTempAttachmentFile,
    resolveFileBackendPath,
    stripFileScheme,
    type SyncBackend,
} from './sync-service-utils';
import { getManagedPath } from './managed-paths';

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
                deps.logSyncWarning('Failed to remove temp attachment file', error);
            }
        }
    } catch (error) {
        deps.logSyncWarning('Failed to scan temp attachment files', error);
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
        const normalizedRawUri = normalizePath(await resolveAttachmentReadPath(rawUri));
        const normalizedAttachmentsDir = normalizePath(await getManagedPath(ATTACHMENTS_DIR_NAME));
        if (
            normalizedRawUri === normalizedAttachmentsDir
            || !normalizedRawUri.startsWith(`${normalizedAttachmentsDir}/`)
        ) return;
        guards.ensureLocalSnapshotFresh();
        await remove(normalizedRawUri);
    } catch (error) {
        if (error instanceof Error && error.name === 'LocalSyncAbort') throw error;
        deps.logSyncWarning(`Failed to delete attachment file ${attachment.title}`, error);
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
        let fileBaseDir: string | null = null;

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
        } else if (backend === 'file') {
            const syncPath = await deps.getSyncPath();
            fileBaseDir = getFileSyncDir(syncPath, SYNC_FILE_NAME, LEGACY_SYNC_FILE_NAME) || null;
            if (!fileBaseDir) return undefined;
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
                guards.ensureLocalSnapshotFresh();
                await deleteDropboxFile(token, cloudKey, dropboxFetcher);
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
                guards.ensureLocalSnapshotFresh();
                await webdavDeleteFile(baseUrl + '/' + target.cloudKey, {
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
            } else if (backend === 'file' && fileBaseDir) {
                // Off the main thread: this delete lands on the sync folder,
                // which may be a slow mount (#1037).
                const { remove } = await import('./sync-fs');
                const { join } = await import('@tauri-apps/api/path');
                const targetPath = await resolveFileBackendPath(join, fileBaseDir, target.cloudKey);
                guards.ensureLocalSnapshotFresh();
                await remove(targetPath);
            }
        };
    };

    const yieldThenEnsureFresh = async (): Promise<void> => {
        await maybeYield();
        guards.ensureLocalSnapshotFresh();
    };

    const result = await runAttachmentCleanupLifecycle({
        appData,
        beforeEachAttachment: yieldThenEnsureFresh,
        beforeEachRemoteDelete: yieldThenEnsureFresh,
        deleteLocalAttachment: (attachment) => deleteAttachmentFile(attachment, deps, guards),
        resolveRemoteDeleteAttachment,
        isRemoteMissingError: (error) => error instanceof DropboxFileNotFoundError,
        onRemoteAttachmentMissing: (target) => {
            deps.logSyncInfo('Remote attachment already missing during cleanup', {
                cloudKey: target.cloudKey,
            });
        },
        onRemoteDeleteError: (target, error) => {
            deps.logSyncWarning('Failed to delete remote attachment ' + target.title, error);
        },
    });

    await cleanupAttachmentTempFiles(deps);
    return result.appData;
};
