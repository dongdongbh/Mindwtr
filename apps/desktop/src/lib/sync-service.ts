
import { mergeAppDataWithStats, AppData, useTaskStore, MergeStats, cloudGetJson, cloudPutJson, webdavGetJson, webdavPutJson } from '@mindwtr/core';
import { isTauriRuntime } from './runtime';
import { logSyncError, sanitizeLogMessage } from './app-log';
import { webStorage } from './storage-adapter-web';

type SyncBackend = 'file' | 'webdav' | 'cloud';

const SYNC_BACKEND_KEY = 'mindwtr-sync-backend';
const WEBDAV_URL_KEY = 'mindwtr-webdav-url';
const WEBDAV_USERNAME_KEY = 'mindwtr-webdav-username';
const WEBDAV_PASSWORD_KEY = 'mindwtr-webdav-password';
const CLOUD_URL_KEY = 'mindwtr-cloud-url';
const CLOUD_TOKEN_KEY = 'mindwtr-cloud-token';

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const mod = await import('@tauri-apps/api/core');
    return mod.invoke<T>(command as any, args as any);
}

type WebDavConfig = { url: string; username: string; password: string };
type CloudConfig = { url: string; token: string };

function normalizeSyncBackend(raw: string | null): SyncBackend {
    return raw === 'webdav' ? 'webdav' : raw === 'cloud' ? 'cloud' : 'file';
}

export class SyncService {
    private static didMigrate = false;
    private static syncInFlight: Promise<{ success: boolean; stats?: MergeStats; error?: string }> | null = null;
    private static syncQueued = false;

    private static getSyncBackendLocal(): SyncBackend {
        return normalizeSyncBackend(localStorage.getItem(SYNC_BACKEND_KEY));
    }

    private static setSyncBackendLocal(backend: SyncBackend) {
        localStorage.setItem(SYNC_BACKEND_KEY, backend);
    }

    private static getWebDavConfigLocal(): WebDavConfig {
        return {
            url: localStorage.getItem(WEBDAV_URL_KEY) || '',
            username: localStorage.getItem(WEBDAV_USERNAME_KEY) || '',
            password: localStorage.getItem(WEBDAV_PASSWORD_KEY) || '',
        };
    }

    private static setWebDavConfigLocal(config: { url: string; username?: string; password?: string }) {
        localStorage.setItem(WEBDAV_URL_KEY, config.url);
        localStorage.setItem(WEBDAV_USERNAME_KEY, config.username || '');
        localStorage.setItem(WEBDAV_PASSWORD_KEY, config.password || '');
    }

    private static getCloudConfigLocal(): CloudConfig {
        return {
            url: localStorage.getItem(CLOUD_URL_KEY) || '',
            token: localStorage.getItem(CLOUD_TOKEN_KEY) || '',
        };
    }

    private static setCloudConfigLocal(config: { url: string; token: string }) {
        localStorage.setItem(CLOUD_URL_KEY, config.url);
        localStorage.setItem(CLOUD_TOKEN_KEY, config.token);
    }

    private static async maybeMigrateLegacyLocalStorageToConfig() {
        if (!isTauriRuntime() || SyncService.didMigrate) return;
        SyncService.didMigrate = true;

        const legacyBackend = localStorage.getItem(SYNC_BACKEND_KEY);
        const legacyWebdav = SyncService.getWebDavConfigLocal();
        const legacyCloud = SyncService.getCloudConfigLocal();

        const hasLegacyBackend = legacyBackend === 'webdav' || legacyBackend === 'cloud';
        const hasLegacyWebdav = Boolean(legacyWebdav.url);
        const hasLegacyCloud = Boolean(legacyCloud.url && legacyCloud.token);

        if (!hasLegacyBackend && !hasLegacyWebdav && !hasLegacyCloud) return;

        try {
            const [currentBackend, currentWebdav, currentCloud] = await Promise.all([
                tauriInvoke<string>('get_sync_backend'),
                tauriInvoke<WebDavConfig>('get_webdav_config'),
                tauriInvoke<CloudConfig>('get_cloud_config'),
            ]);

            let migrated = false;
            if (hasLegacyBackend && normalizeSyncBackend(currentBackend) === 'file') {
                await tauriInvoke('set_sync_backend', { backend: legacyBackend });
                migrated = true;
            }

            if (hasLegacyWebdav && !currentWebdav.url) {
                await tauriInvoke('set_webdav_config', legacyWebdav);
                migrated = true;
            }

            if (hasLegacyCloud && !currentCloud.url && !currentCloud.token) {
                await tauriInvoke('set_cloud_config', legacyCloud);
                migrated = true;
            }

            if (migrated) {
                localStorage.removeItem(SYNC_BACKEND_KEY);
                localStorage.removeItem(WEBDAV_URL_KEY);
                localStorage.removeItem(WEBDAV_USERNAME_KEY);
                localStorage.removeItem(WEBDAV_PASSWORD_KEY);
                localStorage.removeItem(CLOUD_URL_KEY);
                localStorage.removeItem(CLOUD_TOKEN_KEY);
            }
        } catch (error) {
            console.error('Failed to migrate legacy sync config:', error);
        }
    }

    static async getSyncBackend(): Promise<SyncBackend> {
        if (!isTauriRuntime()) return SyncService.getSyncBackendLocal();
        await SyncService.maybeMigrateLegacyLocalStorageToConfig();
        try {
            const backend = await tauriInvoke<string>('get_sync_backend');
            return normalizeSyncBackend(backend);
        } catch (error) {
            console.error('Failed to get sync backend:', error);
            return SyncService.getSyncBackendLocal();
        }
    }

    static async setSyncBackend(backend: SyncBackend): Promise<void> {
        if (!isTauriRuntime()) {
            SyncService.setSyncBackendLocal(backend);
            return;
        }
        try {
            await tauriInvoke('set_sync_backend', { backend });
        } catch (error) {
            console.error('Failed to set sync backend:', error);
        }
    }

    static async getWebDavConfig(): Promise<WebDavConfig> {
        if (!isTauriRuntime()) return SyncService.getWebDavConfigLocal();
        await SyncService.maybeMigrateLegacyLocalStorageToConfig();
        try {
            return await tauriInvoke<WebDavConfig>('get_webdav_config');
        } catch (error) {
            console.error('Failed to get WebDAV config:', error);
            return SyncService.getWebDavConfigLocal();
        }
    }

    static async setWebDavConfig(config: { url: string; username?: string; password?: string }): Promise<void> {
        if (!isTauriRuntime()) {
            SyncService.setWebDavConfigLocal(config);
            return;
        }
        try {
            await tauriInvoke('set_webdav_config', {
                url: config.url,
                username: config.username || '',
                password: config.password || '',
            });
        } catch (error) {
            console.error('Failed to set WebDAV config:', error);
        }
    }

    static async getCloudConfig(): Promise<CloudConfig> {
        if (!isTauriRuntime()) return SyncService.getCloudConfigLocal();
        await SyncService.maybeMigrateLegacyLocalStorageToConfig();
        try {
            return await tauriInvoke<CloudConfig>('get_cloud_config');
        } catch (error) {
            console.error('Failed to get cloud config:', error);
            return SyncService.getCloudConfigLocal();
        }
    }

    static async setCloudConfig(config: { url: string; token: string }): Promise<void> {
        if (!isTauriRuntime()) {
            SyncService.setCloudConfigLocal(config);
            return;
        }
        try {
            await tauriInvoke('set_cloud_config', { url: config.url, token: config.token });
        } catch (error) {
            console.error('Failed to set cloud config:', error);
        }
    }

    /**
     * Get the currently configured sync path from the backend
     */
    static async getSyncPath(): Promise<string> {
        if (!isTauriRuntime()) return '';
        try {
            return await tauriInvoke<string>('get_sync_path');
        } catch (error) {
            console.error('Failed to get sync path:', error);
            return '';
        }
    }

    /**
     * Set the sync path in the backend
     */
    static async setSyncPath(path: string): Promise<{ success: boolean; path: string }> {
        if (!isTauriRuntime()) return { success: false, path: '' };
        try {
            return await tauriInvoke<{ success: boolean; path: string }>('set_sync_path', { syncPath: path });
        } catch (error) {
            console.error('Failed to set sync path:', error);
            return { success: false, path: '' };
        }
    }

    /**
     * Perform a full sync cycle:
     * 1. Read Local & Remote Data
     * 2. Merge (Last-Write-Wins)
     * 3. Write merged data back to both Local & Remote
     * 4. Refresh Core Store
     */
    static async performSync(): Promise<{ success: boolean; stats?: MergeStats; error?: string }> {
        if (SyncService.syncInFlight) {
            SyncService.syncQueued = true;
            return SyncService.syncInFlight;
        }

        let step = 'init';
        let backend: SyncBackend = 'file';
        let syncUrl: string | undefined;

        const runSync = async (): Promise<{ success: boolean; stats?: MergeStats; error?: string }> => {
            // 1. Read Local Data
            step = 'read-local';
            const localData = isTauriRuntime() ? await tauriInvoke<AppData>('get_data') : await webStorage.getData();

            // 2. Read Sync Data (file or WebDAV)
            let syncData: AppData;
            backend = await SyncService.getSyncBackend();
            step = 'read-remote';
            if (backend === 'webdav') {
                const { url, username, password } = await SyncService.getWebDavConfig();
                if (!url) {
                    throw new Error('WebDAV URL not configured');
                }
                syncUrl = url;
                const remote = await webdavGetJson<AppData>(url, { username, password });
                syncData = remote || { tasks: [], projects: [], settings: {} };
            } else if (backend === 'cloud') {
                const { url, token } = await SyncService.getCloudConfig();
                if (!url || !token) {
                    throw new Error('Cloud sync not configured');
                }
                syncUrl = url;
                const remote = await cloudGetJson<AppData>(url, { token });
                syncData = remote || { tasks: [], projects: [], settings: {} };
            } else {
                if (!isTauriRuntime()) {
                    throw new Error('File sync is not available in the web app.');
                }
                syncData = await tauriInvoke<AppData>('read_sync_file');
            }

            // 3. Merge Strategies
            // mergeAppData uses Last-Write-Wins (LWW) based on updatedAt
            step = 'merge';
            const mergeResult = mergeAppDataWithStats(localData, syncData);
            const mergedData = mergeResult.data;
            const stats = mergeResult.stats;

            const now = new Date().toISOString();
            const finalData: AppData = {
                ...mergedData,
                settings: {
                    ...mergedData.settings,
                    lastSyncAt: now,
                    lastSyncStatus: 'success',
                    lastSyncError: undefined,
                    lastSyncStats: stats,
                },
            };

            // 4. Write back to Local
            step = 'write-local';
            if (isTauriRuntime()) {
                await tauriInvoke('save_data', { data: finalData });
            } else {
                await webStorage.saveData(finalData);
            }

            // 5. Write back to Sync
            step = 'write-remote';
            if (backend === 'webdav') {
                const { url, username, password } = await SyncService.getWebDavConfig();
                await webdavPutJson(url, finalData, { username, password });
            } else if (backend === 'cloud') {
                const { url, token } = await SyncService.getCloudConfig();
                await cloudPutJson(url, finalData, { token });
            } else {
                await tauriInvoke('write_sync_file', { data: finalData });
            }

            // 6. Refresh UI Store
            step = 'refresh';
            await useTaskStore.getState().fetchData();

            return { success: true, stats };
        };

        const resultPromise = runSync().catch(async (error) => {
            console.error('Sync failed', error);
            const now = new Date().toISOString();
            const logPath = await logSyncError(error, {
                backend,
                step,
                url: syncUrl,
            });
            const logHint = logPath ? ` (log: ${logPath})` : '';
            const safeMessage = sanitizeLogMessage(String(error));
            try {
                await useTaskStore.getState().fetchData();
                await useTaskStore.getState().updateSettings({
                    lastSyncAt: now,
                    lastSyncStatus: 'error',
                    lastSyncError: `${safeMessage}${logHint}`,
                });
            } catch (e) {
                console.error('Failed to persist sync error', e);
            }
            return { success: false, error: `${safeMessage}${logHint}` };
        });

        SyncService.syncInFlight = resultPromise;
        const result = await resultPromise;
        SyncService.syncInFlight = null;

        if (SyncService.syncQueued) {
            SyncService.syncQueued = false;
            void SyncService.performSync();
        }

        return result;
    }
}
