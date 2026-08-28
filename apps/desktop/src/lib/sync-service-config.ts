import { normalizeCloudProvider, type CloudProvider } from '@mindwtr/core';

import type { CloudConfig, WebDavConfig } from './sync-attachment-backends';
import { normalizeSyncBackend, type SyncBackend } from './sync-service-utils';

export const SYNC_BACKEND_KEY = 'mindwtr-sync-backend';
export const WEBDAV_URL_KEY = 'mindwtr-webdav-url';
export const WEBDAV_USERNAME_KEY = 'mindwtr-webdav-username';
export const WEBDAV_PASSWORD_KEY = 'mindwtr-webdav-password';
export const WEBDAV_ALLOW_INSECURE_HTTP_KEY = 'mindwtr-webdav-allow-insecure-http';
export const WEBDAV_ALLOW_WEAK_FINGERPRINT_KEY = 'mindwtr-webdav-allow-weak-fingerprint';
export const CLOUD_URL_KEY = 'mindwtr-cloud-url';
export const CLOUD_TOKEN_KEY = 'mindwtr-cloud-token';
export const CLOUD_ALLOW_INSECURE_HTTP_KEY = 'mindwtr-cloud-allow-insecure-http';
export const CLOUD_REMEMBER_TOKEN_KEY = 'mindwtr-cloud-remember-token';
export const CLOUD_PROVIDER_KEY = 'mindwtr-cloud-provider';
const DEFAULT_DROPBOX_APP_KEY = String(import.meta.env.VITE_DROPBOX_APP_KEY || '').trim();

type ConfigDeps = {
    isTauriRuntimeEnv: () => boolean;
    maybeMigrateLegacyLocalStorageToConfig: () => Promise<void>;
    reportError: (message: string, error: unknown) => void;
    invokeNative: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
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
    const password = sessionStorage.getItem(WEBDAV_PASSWORD_KEY) || '';
    return {
        url: localStorage.getItem(WEBDAV_URL_KEY) || '',
        username: localStorage.getItem(WEBDAV_USERNAME_KEY) || '',
        password,
        hasPassword: Boolean(password),
        allowInsecureHttp: localStorage.getItem(WEBDAV_ALLOW_INSECURE_HTTP_KEY) === 'true',
        allowWeakFingerprint: localStorage.getItem(WEBDAV_ALLOW_WEAK_FINGERPRINT_KEY) !== 'false',
    };
};

type WebDavConfigWrite = {
    url: string;
    username?: string;
    password?: string;
    allowInsecureHttp?: boolean;
    allowWeakFingerprint?: boolean;
    replacePassword?: boolean;
};

const setWebDavConfigLocal = (config: WebDavConfigWrite) => {
    localStorage.setItem(WEBDAV_URL_KEY, config.url);
    localStorage.setItem(WEBDAV_USERNAME_KEY, config.username || '');
    localStorage.setItem(WEBDAV_ALLOW_INSECURE_HTTP_KEY, config.allowInsecureHttp === true ? 'true' : 'false');
    localStorage.setItem(WEBDAV_ALLOW_WEAK_FINGERPRINT_KEY, config.allowWeakFingerprint === false ? 'false' : 'true');
    if (!config.url || config.replacePassword === true) {
        if (config.password) {
            sessionStorage.setItem(WEBDAV_PASSWORD_KEY, config.password);
        } else {
            sessionStorage.removeItem(WEBDAV_PASSWORD_KEY);
        }
    } else if (config.password) {
        sessionStorage.setItem(WEBDAV_PASSWORD_KEY, config.password);
    }
};

export const getCloudConfigLocal = (): CloudConfig => {
    const rememberToken = localStorage.getItem(CLOUD_REMEMBER_TOKEN_KEY) === 'true';
    const sessionToken = sessionStorage.getItem(CLOUD_TOKEN_KEY) || '';
    const legacyLocalToken = localStorage.getItem(CLOUD_TOKEN_KEY) || '';
    const token = rememberToken ? (legacyLocalToken || sessionToken) : (sessionToken || legacyLocalToken);
    if (!rememberToken && !sessionToken && legacyLocalToken) {
        sessionStorage.setItem(CLOUD_TOKEN_KEY, legacyLocalToken);
        localStorage.removeItem(CLOUD_TOKEN_KEY);
    }
    return {
        url: localStorage.getItem(CLOUD_URL_KEY) || '',
        token,
        allowInsecureHttp: localStorage.getItem(CLOUD_ALLOW_INSECURE_HTTP_KEY) === 'true',
        rememberToken,
    };
};

const setCloudConfigLocal = (config: { url: string; token?: string; allowInsecureHttp?: boolean; rememberToken?: boolean }) => {
    const rememberToken = config.rememberToken === true;
    localStorage.setItem(CLOUD_URL_KEY, config.url);
    localStorage.setItem(CLOUD_ALLOW_INSECURE_HTTP_KEY, config.allowInsecureHttp === true ? 'true' : 'false');
    if (rememberToken) {
        localStorage.setItem(CLOUD_REMEMBER_TOKEN_KEY, 'true');
    } else {
        localStorage.removeItem(CLOUD_REMEMBER_TOKEN_KEY);
    }
    if (config.token) {
        if (rememberToken) {
            localStorage.setItem(CLOUD_TOKEN_KEY, config.token);
            sessionStorage.removeItem(CLOUD_TOKEN_KEY);
        } else {
            sessionStorage.setItem(CLOUD_TOKEN_KEY, config.token);
            localStorage.removeItem(CLOUD_TOKEN_KEY);
        }
    } else {
        sessionStorage.removeItem(CLOUD_TOKEN_KEY);
        localStorage.removeItem(CLOUD_TOKEN_KEY);
    }
};

const getCloudProviderLocal = (): CloudProvider => {
    return normalizeCloudProvider(localStorage.getItem(CLOUD_PROVIDER_KEY));
};

const setCloudProviderLocal = (provider: CloudProvider) => {
    localStorage.setItem(CLOUD_PROVIDER_KEY, normalizeCloudProvider(provider));
};

const parsePersistedCloudProvider = (value: string): CloudProvider => {
    if (value === 'selfhosted' || value === 'dropbox') return value;
    throw new Error(`Invalid persisted cloud provider: ${value}`);
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
        const backend = await deps.invokeNative<string>('get_sync_backend');
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
        await deps.invokeNative('set_sync_backend', { backend });
        await deps.startFileWatcher();
    } catch (error) {
        deps.reportError('Failed to set sync backend', error);
        throw error;
    }
}

export async function readWebDavConfig(
    deps: ConfigDeps,
    options?: { silent?: boolean },
): Promise<WebDavConfig> {
    if (!deps.isTauriRuntimeEnv()) return getWebDavConfigLocal();
    await deps.maybeMigrateLegacyLocalStorageToConfig();
    try {
        return await deps.invokeNative<WebDavConfig>('get_webdav_config');
    } catch (error) {
        if (!options?.silent) {
            deps.reportError('Failed to get WebDAV config', error);
        }
        return { url: '', username: '', hasPassword: false, allowInsecureHttp: false, allowWeakFingerprint: true };
    }
}

export async function writeWebDavConfig(
    config: WebDavConfigWrite,
    deps: ConfigDeps,
): Promise<void> {
    if (!deps.isTauriRuntimeEnv()) {
        setWebDavConfigLocal(config);
        return;
    }
    try {
        await deps.invokeNative('set_webdav_config', {
            url: config.url,
            username: config.username || '',
            password: config.password || '',
            allowInsecureHttp: config.allowInsecureHttp === true,
            allowWeakFingerprint: config.allowWeakFingerprint,
            replacePassword: config.replacePassword === true,
        });
    } catch (error) {
        deps.reportError('Failed to set WebDAV config', error);
        throw error;
    }
}

export async function readCloudConfig(
    deps: ConfigDeps,
    options?: { silent?: boolean },
): Promise<CloudConfig> {
    if (!deps.isTauriRuntimeEnv()) return getCloudConfigLocal();
    await deps.maybeMigrateLegacyLocalStorageToConfig();
    try {
        return await deps.invokeNative<CloudConfig>('get_cloud_config');
    } catch (error) {
        if (!options?.silent) {
            deps.reportError('Failed to get Self-Hosted config', error);
        }
        return { url: '', token: '', allowInsecureHttp: false };
    }
}

export async function writeCloudConfig(
    config: { url: string; token?: string; allowInsecureHttp?: boolean; rememberToken?: boolean },
    deps: ConfigDeps,
): Promise<void> {
    if (!deps.isTauriRuntimeEnv()) {
        setCloudConfigLocal(config);
        return;
    }
    try {
        await deps.invokeNative('set_cloud_config', {
            url: config.url,
            token: config.token || '',
            allowInsecureHttp: config.allowInsecureHttp === true,
        });
    } catch (error) {
        deps.reportError('Failed to set Self-Hosted config', error);
        throw error;
    }
}

export async function readCloudProvider(deps: ConfigDeps): Promise<CloudProvider> {
    if (!deps.isTauriRuntimeEnv()) return getCloudProviderLocal();
    await deps.maybeMigrateLegacyLocalStorageToConfig();
    try {
        const provider = await deps.invokeNative<string>('get_sync_cloud_provider');
        return parsePersistedCloudProvider(provider);
    } catch (error) {
        deps.reportError('Failed to get cloud sync provider', error);
        throw error;
    }
}

export async function writeCloudProvider(provider: CloudProvider, deps: ConfigDeps): Promise<void> {
    const normalizedProvider = normalizeCloudProvider(provider);
    if (!deps.isTauriRuntimeEnv()) {
        setCloudProviderLocal(normalizedProvider);
        return;
    }
    await deps.maybeMigrateLegacyLocalStorageToConfig();
    try {
        await deps.invokeNative('set_sync_cloud_provider', { provider: normalizedProvider });
        const persistedProvider = parsePersistedCloudProvider(
            await deps.invokeNative<string>('get_sync_cloud_provider'),
        );
        if (persistedProvider !== normalizedProvider) {
            throw new Error('Cloud sync provider did not persist correctly');
        }
        // In Tauri, native state is authoritative. This key exists only long
        // enough to migrate older renderer-owned installations.
        localStorage.removeItem(CLOUD_PROVIDER_KEY);
    } catch (error) {
        deps.reportError('Failed to set cloud sync provider', error);
        throw error;
    }
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
        return await deps.invokeNative<string>('get_sync_path');
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
        const result = await deps.invokeNative<{ success: boolean; path: string }>('set_sync_path', { syncPath: path });
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

export async function testSyncPath(path: string, deps: ConfigDeps): Promise<void> {
    if (!deps.isTauriRuntimeEnv()) {
        throw new Error('Desktop runtime is required to test a file sync folder.');
    }
    try {
        await deps.invokeNative('test_sync_path', { syncPath: path });
    } catch (error) {
        deps.reportError('Failed to test sync path', error);
        throw error;
    }
}

export async function clearSyncPath(deps: ConfigWriteDeps): Promise<void> {
    if (!deps.isTauriRuntimeEnv()) return;
    try {
        await deps.invokeNative('clear_sync_path');
        await deps.startFileWatcher();
    } catch (error) {
        deps.reportError('Failed to clear sync path', error);
        throw error;
    }
}
