import { normalizeCloudProvider, type CloudProvider } from '@mindwtr/core';

import type { CloudConfig, WebDavConfig } from './sync-attachment-backends';
import { normalizeSyncBackend, type SyncBackend } from './sync-service-utils';

export const SYNC_BACKEND_KEY = 'mindwtr-sync-backend';
export const WEBDAV_URL_KEY = 'mindwtr-webdav-url';
export const WEBDAV_USERNAME_KEY = 'mindwtr-webdav-username';
export const WEBDAV_PASSWORD_KEY = 'mindwtr-webdav-password';
export const CLOUD_URL_KEY = 'mindwtr-cloud-url';
export const CLOUD_TOKEN_KEY = 'mindwtr-cloud-token';
const CLOUD_PROVIDER_KEY = 'mindwtr-cloud-provider';
const DEFAULT_DROPBOX_APP_KEY = String(import.meta.env.VITE_DROPBOX_APP_KEY || '').trim();

type ConfigDeps = {
    isTauriRuntimeEnv: () => boolean;
    maybeMigrateLegacyLocalStorageToConfig: () => Promise<void>;
    reportError: (message: string, error: unknown) => void;
    tauriInvoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
};

type ConfigWriteDeps = ConfigDeps & {
    startFileWatcher: () => Promise<void>;
};

export const getSyncBackendLocal = (): SyncBackend => {
    return normalizeSyncBackend(localStorage.getItem(SYNC_BACKEND_KEY));
};

const setSyncBackendLocal = (backend: SyncBackend) => {
    localStorage.setItem(SYNC_BACKEND_KEY, backend);
};

export const getWebDavConfigLocal = (): WebDavConfig => {
    return {
        url: localStorage.getItem(WEBDAV_URL_KEY) || '',
        username: localStorage.getItem(WEBDAV_USERNAME_KEY) || '',
        password: '',
        hasPassword: false,
    };
};

const setWebDavConfigLocal = (config: { url: string; username?: string; password?: string }) => {
    localStorage.setItem(WEBDAV_URL_KEY, config.url);
    localStorage.setItem(WEBDAV_USERNAME_KEY, config.username || '');
};

export const getCloudConfigLocal = (): CloudConfig => {
    const sessionToken = sessionStorage.getItem(CLOUD_TOKEN_KEY) || '';
    const legacyLocalToken = localStorage.getItem(CLOUD_TOKEN_KEY) || '';
    const token = sessionToken || legacyLocalToken;
    if (!sessionToken && legacyLocalToken) {
        sessionStorage.setItem(CLOUD_TOKEN_KEY, legacyLocalToken);
        localStorage.removeItem(CLOUD_TOKEN_KEY);
    }
    return {
        url: localStorage.getItem(CLOUD_URL_KEY) || '',
        token,
    };
};

const setCloudConfigLocal = (config: { url: string; token?: string }) => {
    localStorage.setItem(CLOUD_URL_KEY, config.url);
    if (config.token) {
        sessionStorage.setItem(CLOUD_TOKEN_KEY, config.token);
    } else {
        sessionStorage.removeItem(CLOUD_TOKEN_KEY);
    }
    localStorage.removeItem(CLOUD_TOKEN_KEY);
};

const getCloudProviderLocal = (): CloudProvider => {
    return normalizeCloudProvider(localStorage.getItem(CLOUD_PROVIDER_KEY));
};

const setCloudProviderLocal = (provider: CloudProvider) => {
    localStorage.setItem(CLOUD_PROVIDER_KEY, normalizeCloudProvider(provider));
};

const getDropboxAppKeyLocal = (): string => {
    return DEFAULT_DROPBOX_APP_KEY;
};

const setDropboxAppKeyLocal = (_value: string) => {
    // Dropbox app key is provided via build env (VITE_DROPBOX_APP_KEY).
};

export async function readSyncBackend(deps: ConfigDeps): Promise<SyncBackend> {
    if (!deps.isTauriRuntimeEnv()) return getSyncBackendLocal();
    await deps.maybeMigrateLegacyLocalStorageToConfig();
    try {
        const backend = await deps.tauriInvoke<string>('get_sync_backend');
        return normalizeSyncBackend(backend);
    } catch (error) {
        deps.reportError('Failed to get sync backend', error);
        return 'off';
    }
}

export async function writeSyncBackend(backend: SyncBackend, deps: ConfigWriteDeps): Promise<void> {
    if (!deps.isTauriRuntimeEnv()) {
        setSyncBackendLocal(backend);
        return;
    }
    try {
        await deps.tauriInvoke('set_sync_backend', { backend });
        await deps.startFileWatcher();
    } catch (error) {
        deps.reportError('Failed to set sync backend', error);
    }
}

export async function readWebDavConfig(
    deps: ConfigDeps,
    options?: { silent?: boolean },
): Promise<WebDavConfig> {
    if (!deps.isTauriRuntimeEnv()) return getWebDavConfigLocal();
    await deps.maybeMigrateLegacyLocalStorageToConfig();
    try {
        return await deps.tauriInvoke<WebDavConfig>('get_webdav_config');
    } catch (error) {
        if (!options?.silent) {
            deps.reportError('Failed to get WebDAV config', error);
        }
        return { url: '', username: '', hasPassword: false };
    }
}

export async function writeWebDavConfig(
    config: { url: string; username?: string; password?: string },
    deps: ConfigDeps,
): Promise<void> {
    if (!deps.isTauriRuntimeEnv()) {
        setWebDavConfigLocal(config);
        return;
    }
    try {
        await deps.tauriInvoke('set_webdav_config', {
            url: config.url,
            username: config.username || '',
            password: config.password || '',
        });
    } catch (error) {
        deps.reportError('Failed to set WebDAV config', error);
    }
}

export async function readCloudConfig(
    deps: ConfigDeps,
    options?: { silent?: boolean },
): Promise<CloudConfig> {
    if (!deps.isTauriRuntimeEnv()) return getCloudConfigLocal();
    await deps.maybeMigrateLegacyLocalStorageToConfig();
    try {
        return await deps.tauriInvoke<CloudConfig>('get_cloud_config');
    } catch (error) {
        if (!options?.silent) {
            deps.reportError('Failed to get Self-Hosted config', error);
        }
        return { url: '', token: '' };
    }
}

export async function writeCloudConfig(
    config: { url: string; token?: string },
    deps: ConfigDeps,
): Promise<void> {
    if (!deps.isTauriRuntimeEnv()) {
        setCloudConfigLocal(config);
        return;
    }
    try {
        await deps.tauriInvoke('set_cloud_config', {
            url: config.url,
            token: config.token || '',
        });
    } catch (error) {
        deps.reportError('Failed to set Self-Hosted config', error);
    }
}

export async function readCloudProvider(): Promise<CloudProvider> {
    return getCloudProviderLocal();
}

export async function writeCloudProvider(provider: CloudProvider): Promise<void> {
    setCloudProviderLocal(provider);
}

export async function readDropboxAppKey(): Promise<string> {
    return getDropboxAppKeyLocal();
}

export async function writeDropboxAppKey(value: string): Promise<void> {
    setDropboxAppKeyLocal(value);
}

export async function readSyncPath(deps: ConfigDeps): Promise<string> {
    if (!deps.isTauriRuntimeEnv()) return '';
    try {
        return await deps.tauriInvoke<string>('get_sync_path');
    } catch (error) {
        deps.reportError('Failed to get sync path', error);
        return '';
    }
}

export async function writeSyncPath(
    path: string,
    deps: ConfigWriteDeps,
): Promise<{ success: boolean; path: string; error?: string }> {
    if (!deps.isTauriRuntimeEnv()) {
        return { success: false, path: '', error: 'Desktop runtime is required for file sync.' };
    }
    try {
        const result = await deps.tauriInvoke<{ success: boolean; path: string }>('set_sync_path', { syncPath: path });
        if (result?.success) {
            await deps.startFileWatcher();
        }
        return result;
    } catch (error) {
        deps.reportError('Failed to set sync path', error);
        const message = error instanceof Error ? error.message : String(error);
        return { success: false, path: '', error: message };
    }
}
