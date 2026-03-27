import {
    type AppData,
    type Attachment,
    cloudDeleteFile,
    findDeletedAttachmentsForFileCleanup,
    findOrphanedAttachments,
    getErrorStatus,
    removeOrphanedAttachmentsFromData,
    type CloudProvider,
    webdavDeleteFile,
} from '@mindwtr/core';

import { deleteDropboxFile, DropboxFileNotFoundError, DropboxUnauthorizedError } from './dropbox-sync';
import { getBaseSyncUrl, getCloudBaseUrl, normalizePendingRemoteDeletes } from './sync-attachments';
import type { CloudConfig, WebDavConfig } from './sync-attachment-backends';
import {
    ATTACHMENTS_DIR_NAME,
    createCooperativeYield,
    getFileSyncDir,
    isTempAttachmentFile,
    stripFileScheme,
    type SyncBackend,
} from './sync-service-utils';

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

type PendingRemoteAttachmentDeleteEntry = NonNullable<
    NonNullable<AppData['settings']['attachments']>['pendingRemoteDeletes']
>[number];

const LOCAL_ATTACHMENTS_DIR = `mindwtr/${ATTACHMENTS_DIR_NAME}`;
const SYNC_FILE_NAME = 'data.json';
const LEGACY_SYNC_FILE_NAME = 'mindwtr-sync.json';

export const cleanupAttachmentTempFiles = async (deps: Pick<AttachmentCleanupDeps, 'isTauriRuntimeEnv' | 'logSyncWarning'>): Promise<void> => {
    if (!deps.isTauriRuntimeEnv()) return;
    try {
        const { BaseDirectory, readDir, remove } = await import('@tauri-apps/plugin-fs');
        const entries = await readDir(LOCAL_ATTACHMENTS_DIR, { baseDir: BaseDirectory.Data });
        for (const entry of entries) {
            if (!entry.isFile) continue;
            const name = entry.name;
            if (!isTempAttachmentFile(name)) continue;
            try {
                await remove(`${LOCAL_ATTACHMENTS_DIR}/${name}`, { baseDir: BaseDirectory.Data });
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
): Promise<void> => {
    if (!attachment.uri) return;
    const rawUri = stripFileScheme(attachment.uri);
    if (/^https?:\/\//i.test(rawUri) || rawUri.startsWith('content://')) return;
    try {
        const { remove, BaseDirectory } = await import('@tauri-apps/plugin-fs');
        const { dataDir } = await import('@tauri-apps/api/path');
        const baseDataDir = await dataDir();
        if (rawUri.startsWith(baseDataDir)) {
            const relative = rawUri.slice(baseDataDir.length).replace(/^[\\/]/, '');
            await remove(relative, { baseDir: BaseDirectory.Data });
        } else {
            await remove(rawUri);
        }
    } catch (error) {
        deps.logSyncWarning(`Failed to delete attachment file ${attachment.title}`, error);
    }
};

export const cleanupOrphanedAttachments = async (
    appData: AppData,
    backend: SyncBackend,
    deps: AttachmentCleanupDeps,
): Promise<AppData> => {
    const orphaned = findOrphanedAttachments(appData);
    const deletedAttachments = findDeletedAttachmentsForFileCleanup(appData);
    const previousPendingRemoteDeletes = normalizePendingRemoteDeletes(appData.settings.attachments?.pendingRemoteDeletes);
    const previousPendingByCloudKey = new Map(previousPendingRemoteDeletes.map((item) => [item.cloudKey, item]));
    const cleanupTargets = new Map<string, Attachment>();
    const maybeYield = createCooperativeYield(4);

    for (const attachment of orphaned) cleanupTargets.set(attachment.id, attachment);
    for (const attachment of deletedAttachments) cleanupTargets.set(attachment.id, attachment);

    const remoteCleanupTargets = new Map<string, { cloudKey: string; title: string }>();
    for (const attachment of cleanupTargets.values()) {
        await maybeYield();
        if (!attachment.cloudKey) continue;
        remoteCleanupTargets.set(attachment.cloudKey, {
            cloudKey: attachment.cloudKey,
            title: attachment.title || attachment.cloudKey,
        });
    }
    for (const pending of previousPendingRemoteDeletes) {
        await maybeYield();
        remoteCleanupTargets.set(pending.cloudKey, {
            cloudKey: pending.cloudKey,
            title: pending.title || pending.cloudKey,
        });
    }

    const lastCleanupAt = new Date().toISOString();
    if (cleanupTargets.size === 0 && remoteCleanupTargets.size === 0) {
        await cleanupAttachmentTempFiles(deps);
        return {
            ...appData,
            settings: {
                ...appData.settings,
                attachments: {
                    ...appData.settings.attachments,
                    lastCleanupAt,
                    pendingRemoteDeletes: undefined,
                },
            },
        };
    }

    let webdavConfig: WebDavConfig | null = null;
    let cloudConfig: CloudConfig | null = null;
    let cloudProvider: CloudProvider = 'selfhosted';
    let dropboxAppKey = '';
    let dropboxAccessToken: string | null = null;
    let fileBaseDir: string | null = null;

    if (backend === 'webdav') {
        webdavConfig = await deps.getWebDavConfig();
    } else if (backend === 'cloud') {
        cloudProvider = await deps.getCloudProvider();
        if (cloudProvider === 'dropbox') {
            dropboxAppKey = (await deps.getDropboxAppKey()).trim();
        } else {
            cloudConfig = await deps.getCloudConfig();
        }
    } else if (backend === 'file') {
        const syncPath = await deps.getSyncPath();
        const baseDir = getFileSyncDir(syncPath, SYNC_FILE_NAME, LEGACY_SYNC_FILE_NAME);
        fileBaseDir = baseDir || null;
    }

    const fetcher = await deps.getTauriFetch();
    const dropboxFetcher = fetcher ?? fetch;
    const webdavPassword = webdavConfig ? await deps.resolveWebdavPassword(webdavConfig) : '';
    const nextPendingRemoteDeletes = new Map<string, PendingRemoteAttachmentDeleteEntry>();
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

    for (const attachment of cleanupTargets.values()) {
        await maybeYield();
        await deleteAttachmentFile(attachment, deps);
    }

    const canAttemptRemoteDelete = (
        (backend === 'webdav' && !!webdavConfig?.url)
        || (backend === 'cloud' && cloudProvider === 'selfhosted' && !!cloudConfig?.url)
        || (backend === 'cloud' && cloudProvider === 'dropbox' && !!dropboxAppKey)
        || (backend === 'file' && !!fileBaseDir)
    );
    for (const target of remoteCleanupTargets.values()) {
        await maybeYield();
        const existing = previousPendingByCloudKey.get(target.cloudKey);
        if (!canAttemptRemoteDelete) {
            nextPendingRemoteDeletes.set(target.cloudKey, {
                cloudKey: target.cloudKey,
                title: target.title,
                attempts: existing?.attempts ?? 0,
                lastErrorAt: existing?.lastErrorAt,
            });
            continue;
        }
        try {
            if (backend === 'webdav' && webdavConfig?.url) {
                const baseUrl = getBaseSyncUrl(webdavConfig.url);
                await webdavDeleteFile(`${baseUrl}/${target.cloudKey}`, {
                    username: webdavConfig.username,
                    password: webdavPassword,
                    fetcher,
                });
            } else if (backend === 'cloud' && cloudProvider === 'selfhosted' && cloudConfig?.url) {
                const baseUrl = getCloudBaseUrl(cloudConfig.url);
                await cloudDeleteFile(`${baseUrl}/${target.cloudKey}`, {
                    token: cloudConfig.token,
                    fetcher,
                });
            } else if (backend === 'cloud' && cloudProvider === 'dropbox') {
                await deleteDropboxAttachment(target.cloudKey);
            } else if (backend === 'file' && fileBaseDir) {
                const { remove } = await import('@tauri-apps/plugin-fs');
                const { join } = await import('@tauri-apps/api/path');
                const targetPath = await join(fileBaseDir, target.cloudKey);
                await remove(targetPath);
            }
        } catch (error) {
            const status = getErrorStatus(error);
            if (status === 404 || error instanceof DropboxFileNotFoundError) {
                deps.logSyncInfo('Remote attachment already missing during cleanup', {
                    cloudKey: target.cloudKey,
                });
                continue;
            }
            deps.logSyncWarning(`Failed to delete remote attachment ${target.title}`, error);
            nextPendingRemoteDeletes.set(target.cloudKey, {
                cloudKey: target.cloudKey,
                title: target.title,
                attempts: (existing?.attempts ?? 0) + 1,
                lastErrorAt: lastCleanupAt,
            });
        }
    }

    await cleanupAttachmentTempFiles(deps);

    const cleaned = orphaned.length > 0 ? removeOrphanedAttachmentsFromData(appData) : appData;
    const pendingRemoteDeletes = Array.from(nextPendingRemoteDeletes.values());
    return {
        ...cleaned,
        settings: {
            ...cleaned.settings,
            attachments: {
                ...cleaned.settings.attachments,
                lastCleanupAt,
                pendingRemoteDeletes: pendingRemoteDeletes.length > 0 ? pendingRemoteDeletes : undefined,
            },
        },
    };
};
