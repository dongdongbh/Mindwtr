
import { AppData, useTaskStore, MergeStats, webdavGetJson, webdavPutJson, cloudGetJson, cloudPutJson, flushPendingSave, performSyncCycle } from '@mindwtr/core';
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
const SYNC_FILE_NAME = 'data.json';
const LEGACY_SYNC_FILE_NAME = 'mindwtr-sync.json';

const toStableJson = (value: unknown): string => {
    const normalize = (input: any): any => {
        if (Array.isArray(input)) {
            return input.map(normalize);
        }
        if (input && typeof input === 'object') {
            const entries = Object.keys(input)
                .sort()
                .map((key) => [key, normalize(input[key])]);
            const result: Record<string, any> = {};
            for (const [key, val] of entries) {
                result[key] = val;
            }
            return result;
        }
        return input;
    };
    return JSON.stringify(normalize(value));
};

const hashString = (value: string): string => {
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
        hash = Math.imul(31, hash) + value.charCodeAt(i);
        hash |= 0;
    }
    return hash.toString(16);
};

const normalizePath = (input: string) => input.replace(/\\/g, '/').toLowerCase();

const isSyncFilePath = (path: string) => {
    const normalized = normalizePath(path);
    return normalized.endsWith(`/${SYNC_FILE_NAME}`) || normalized.endsWith(`/${LEGACY_SYNC_FILE_NAME}`);
};

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const mod = await import('@tauri-apps/api/core');
    return mod.invoke<T>(command as any, args as any);
}

type WebDavConfig = { url: string; username: string; password: string };
type CloudConfig = { url: string; token: string };

function normalizeSyncBackend(raw: string | null): SyncBackend {
    return raw === 'webdav' || raw === 'cloud' ? raw : 'file';
}

async function getTauriFetch(): Promise<typeof fetch | undefined> {
    if (!isTauriRuntime()) return undefined;
    try {
        const mod = await import('@tauri-apps/plugin-http');
        return mod.fetch;
    } catch (error) {
        console.warn('Failed to load tauri http fetch', error);
        return undefined;
    }
}

export class SyncService {
    private static didMigrate = false;
    private static syncInFlight: Promise<{ success: boolean; stats?: MergeStats; error?: string }> | null = null;
    private static syncQueued = false;
    private static fileWatcherStop: (() => void) | null = null;
    private static fileWatcherPath: string | null = null;
    private static fileWatcherBackend: SyncBackend | null = null;
    private static lastWrittenHash: string | null = null;
    private static lastObservedHash: string | null = null;
    private static ignoreFileEventsUntil = 0;
    private static externalSyncTimer: ReturnType<typeof setTimeout> | null = null;

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

    private static setCloudConfigLocal(config: { url: string; token?: string }) {
        localStorage.setItem(CLOUD_URL_KEY, config.url);
        localStorage.setItem(CLOUD_TOKEN_KEY, config.token || '');
    }

    private static async maybeMigrateLegacyLocalStorageToConfig() {
        if (!isTauriRuntime() || SyncService.didMigrate) return;
        SyncService.didMigrate = true;

        const legacyBackend = localStorage.getItem(SYNC_BACKEND_KEY);
        const legacyWebdav = SyncService.getWebDavConfigLocal();
        const legacyCloud = SyncService.getCloudConfigLocal();
        const hasLegacyBackend = legacyBackend === 'webdav' || legacyBackend === 'cloud';
        const hasLegacyWebdav = Boolean(legacyWebdav.url);
        const hasLegacyCloud = Boolean(legacyCloud.url || legacyCloud.token);
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
                await tauriInvoke('set_cloud_config', { url: legacyCloud.url, token: legacyCloud.token });
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
            await SyncService.startFileWatcher();
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
            console.error('Failed to get Self-Hosted config:', error);
            return SyncService.getCloudConfigLocal();
        }
    }

    static async setCloudConfig(config: { url: string; token?: string }): Promise<void> {
        if (!isTauriRuntime()) {
            SyncService.setCloudConfigLocal(config);
            return;
        }
        try {
            await tauriInvoke('set_cloud_config', {
                url: config.url,
                token: config.token || '',
            });
        } catch (error) {
            console.error('Failed to set Self-Hosted config:', error);
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
            const result = await tauriInvoke<{ success: boolean; path: string }>('set_sync_path', { syncPath: path });
            if (result?.success) {
                await SyncService.startFileWatcher();
            }
            return result;
        } catch (error) {
            console.error('Failed to set sync path:', error);
            return { success: false, path: '' };
        }
    }

    private static markSyncWrite(data: AppData) {
        const hash = hashString(toStableJson(data));
        SyncService.lastWrittenHash = hash;
        SyncService.ignoreFileEventsUntil = Date.now() + 2000;
    }

    private static async handleFileChange(paths: string[]) {
        if (!isTauriRuntime()) return;
        if (Date.now() < SyncService.ignoreFileEventsUntil) return;

        const hasSyncFile = paths.some(isSyncFilePath);
        if (!hasSyncFile) return;

        try {
            const syncData = await tauriInvoke<AppData>('read_sync_file');
            const normalized = normalizeAppData(syncData);
            const hash = hashString(toStableJson(normalized));
            if (hash === SyncService.lastWrittenHash) {
                return;
            }
            if (hash === SyncService.lastObservedHash) {
                return;
            }
            SyncService.lastObservedHash = hash;

            if (SyncService.externalSyncTimer) {
                clearTimeout(SyncService.externalSyncTimer);
            }
            SyncService.externalSyncTimer = setTimeout(() => {
                SyncService.performSync().catch(console.error);
            }, 750);
        } catch (error) {
            console.warn('Failed to process external sync change', error);
        }
    }

    private static resolveUnwatch(unwatch: unknown): (() => void) | null {
        if (typeof unwatch === 'function') return unwatch as () => void;
        if (unwatch && typeof (unwatch as any).stop === 'function') {
            return () => (unwatch as any).stop();
        }
        if (unwatch && typeof (unwatch as any).unwatch === 'function') {
            return () => (unwatch as any).unwatch();
        }
        return null;
    }

    static async startFileWatcher(): Promise<void> {
        if (!isTauriRuntime()) return;
        const backend = await SyncService.getSyncBackend();
        if (backend !== 'file') {
            await SyncService.stopFileWatcher();
            return;
        }
        const syncPath = await SyncService.getSyncPath();
        if (!syncPath) {
            await SyncService.stopFileWatcher();
            return;
        }
        const watchPath = syncPath;
        if (SyncService.fileWatcherStop && SyncService.fileWatcherPath === watchPath && SyncService.fileWatcherBackend === backend) {
            return;
        }

        await SyncService.stopFileWatcher();

        try {
            const { watch } = await import('@tauri-apps/plugin-fs');
            const unwatch = await watch(watchPath, (event: any) => {
                const paths = Array.isArray(event?.paths)
                    ? event.paths
                    : event?.path
                        ? [event.path]
                        : [];
                if (paths.length === 0) return;
                void SyncService.handleFileChange(paths);
            });
            SyncService.fileWatcherStop = SyncService.resolveUnwatch(unwatch);
            SyncService.fileWatcherPath = watchPath;
            SyncService.fileWatcherBackend = backend;
        } catch (error) {
            console.warn('Failed to start sync file watcher', error);
        }
    }

    static async stopFileWatcher(): Promise<void> {
        if (SyncService.fileWatcherStop) {
            try {
                SyncService.fileWatcherStop();
            } catch (error) {
                console.warn('Failed to stop sync watcher', error);
            }
        }
        SyncService.fileWatcherStop = null;
        SyncService.fileWatcherPath = null;
        SyncService.fileWatcherBackend = null;
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
            // 1. Flush pending writes so disk reflects the latest state
            step = 'flush';
            await flushPendingSave();

            // 2. Read/merge/write via shared core orchestration.
            backend = await SyncService.getSyncBackend();
            const syncResult = await performSyncCycle({
                readLocal: async () => (
                    isTauriRuntime()
                        ? await tauriInvoke<AppData>('get_data')
                        : await webStorage.getData()
                ),
                readRemote: async () => {
                    if (backend === 'webdav') {
                        const { url, username, password } = await SyncService.getWebDavConfig();
                        if (!url) {
                            throw new Error('WebDAV URL not configured');
                        }
                        syncUrl = url;
                        const fetcher = await getTauriFetch();
                        return await webdavGetJson<AppData>(url, { username, password, fetcher });
                    }
                    if (backend === 'cloud') {
                        const { url, token } = await SyncService.getCloudConfig();
                        if (!url) {
                            throw new Error('Self-hosted URL not configured');
                        }
                        syncUrl = url;
                        const fetcher = await getTauriFetch();
                        return await cloudGetJson<AppData>(url, { token, fetcher });
                    }
                    if (!isTauriRuntime()) {
                        throw new Error('File sync is not available in the web app.');
                    }
                    return await tauriInvoke<AppData>('read_sync_file');
                },
                writeLocal: async (data) => {
                    if (isTauriRuntime()) {
                        await tauriInvoke('save_data', { data });
                    } else {
                        await webStorage.saveData(data);
                    }
                },
                writeRemote: async (data) => {
                    if (backend === 'webdav') {
                        const { url, username, password } = await SyncService.getWebDavConfig();
                        const fetcher = await getTauriFetch();
                        await webdavPutJson(url, data, { username, password, fetcher });
                        return;
                    }
                    if (backend === 'cloud') {
                        const { url, token } = await SyncService.getCloudConfig();
                        const fetcher = await getTauriFetch();
                        await cloudPutJson(url, data, { token, fetcher });
                        return;
                    }
                    SyncService.markSyncWrite(data);
                    await tauriInvoke('write_sync_file', { data });
                },
                onStep: (next) => {
                    step = next;
                },
            });
            const stats = syncResult.stats;

            // 7. Refresh UI Store
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
