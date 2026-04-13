import type { CloudProvider } from './sync-service';
import type { SyncBackend } from './sync-service-utils';

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
    if (backend === 'off') return false;

    if (backend === 'file') {
        const path = await syncService.getSyncPath();
        return Boolean(path);
    }

    if (backend === 'webdav') {
        const { url } = await syncService.getWebDavConfig();
        return Boolean(url);
    }

    if (backend === 'cloud') {
        const provider = await syncService.getCloudProvider();
        if (provider === 'dropbox') {
            const appKey = (await syncService.getDropboxAppKey()).trim();
            if (!appKey) return false;
            return syncService.isDropboxConnected(appKey);
        }

        const { url } = await syncService.getCloudConfig();
        return Boolean(url);
    }

    return false;
}
