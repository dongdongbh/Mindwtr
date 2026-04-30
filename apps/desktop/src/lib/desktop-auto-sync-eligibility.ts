import { canAutoSync, type SyncBackend } from '@mindwtr/core';
import type { CloudProvider } from './sync-service';

type SyncServiceLike = {
    getSyncBackend: () => Promise<SyncBackend>;
    getSyncPath: () => Promise<string>;
    getWebDavConfig: () => Promise<{ url: string }>;
    getCloudConfig: () => Promise<{ url: string }>;
    getCloudProvider: () => Promise<CloudProvider>;
    getDropboxAppKey: () => Promise<string>;
    isDropboxConnected: (clientId: string) => Promise<boolean>;
};

export async function canDesktopAutoSync(syncService: SyncServiceLike): Promise<boolean> {
    const backend = await syncService.getSyncBackend();
    const filePath = backend === 'file' ? await syncService.getSyncPath() : undefined;
    const webdavUrl = backend === 'webdav' ? (await syncService.getWebDavConfig()).url : undefined;
    const cloudProvider = backend === 'cloud' ? await syncService.getCloudProvider() : undefined;
    const dropboxAppKey = backend === 'cloud' && cloudProvider === 'dropbox'
        ? (await syncService.getDropboxAppKey()).trim()
        : undefined;
    const isDropboxConnected = backend === 'cloud' && cloudProvider === 'dropbox' && dropboxAppKey
        ? await syncService.isDropboxConnected(dropboxAppKey)
        : undefined;
    const cloudUrl = backend === 'cloud' && cloudProvider !== 'dropbox'
        ? (await syncService.getCloudConfig()).url
        : undefined;

    return canAutoSync({
        backend,
        filePath,
        webdavUrl,
        cloudProvider,
        dropboxAppKey,
        isDropboxConnected,
        cloudUrl,
    });
}
