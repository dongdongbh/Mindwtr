import { isWebdavRateLimitedError } from './sync-runtime-utils';

export type SyncBackend = 'off' | 'file' | 'webdav' | 'cloud' | 'cloudkit';
export type SyncCloudProvider = 'dropbox' | 'selfhosted';
export type AutoSyncConfig = {
    backend: SyncBackend;
    filePath?: string;
    webdavUrl?: string;
    cloudProvider?: SyncCloudProvider;
    cloudUrl?: string;
    dropboxAppKey?: string;
    isDropboxConnected?: boolean;
};

const DEFAULT_SYNC_FILE_NAME = 'data.json';
const DEFAULT_LEGACY_SYNC_FILE_NAME = 'mindwtr-sync.json';
const AI_KEY_PATTERNS = [
    /sk-[A-Za-z0-9-]{10,}/g,
    /sk-ant-[A-Za-z0-9-]{10,}/g,
    /rk-[A-Za-z0-9]{10,}/g,
    /AIza[0-9A-Za-z\-_]{10,}/g,
];
const TOKEN_PATTERN = /(password|pass|token|access_token|api_key|apikey|authorization|username|user|secret|session|cookie)=([^\s&]+)/gi;
const AUTH_HEADER_PATTERN = /(Authorization:\s*)(Basic|Bearer)\s+[A-Za-z0-9+\/=._-]+/gi;
const READONLY_ERROR_PATTERN = /isn't writable|not writable|read-only|read only|permission denied|EACCES/i;
const OFFLINE_ERROR_PATTERNS = [
    /offline state detected/i,
    /network request failed/i,
    /internet connection appears to be offline/i,
    /airplane mode/i,
    /unable to resolve host/i,
    /failed host lookup/i,
    /name or service not known/i,
    /nodename nor servname provided/i,
    /unknownhostexception/i,
    /eai_again/i,
    /enotfound/i,
    /network is unreachable/i,
    /no route to host/i,
    /software caused connection abort/i,
    /econnreset/i,
    /econnaborted/i,
    /etimedout/i,
    /failed to connect to/i,
];

export const normalizePath = (input: string): string => input.replace(/\\/g, '/').toLowerCase();

export const isSyncFilePath = (
    path: string,
    syncFileName = DEFAULT_SYNC_FILE_NAME,
    legacySyncFileName = DEFAULT_LEGACY_SYNC_FILE_NAME
): boolean => {
    const normalized = normalizePath(path);
    return normalized.endsWith(`/${syncFileName}`) || normalized.endsWith(`/${legacySyncFileName}`);
};

export const normalizeSyncBackend = (raw: string | null): SyncBackend => {
    if (raw === 'off' || raw === 'file' || raw === 'webdav' || raw === 'cloud' || raw === 'cloudkit') return raw;
    return 'off';
};

export const resolveSyncBackend = (value: string | null): SyncBackend => normalizeSyncBackend(value);

export const coerceSupportedSyncBackend = (backend: SyncBackend, options?: { allowCloudKit?: boolean }): SyncBackend => (
    backend === 'cloudkit' && options?.allowCloudKit === false ? 'off' : backend
);

export const isRemoteSyncBackend = (backend: SyncBackend): boolean => (
    backend === 'webdav' || backend === 'cloud' || backend === 'cloudkit'
);

export const canAutoSync = (config: AutoSyncConfig): boolean => {
    if (config.backend === 'off') return false;
    if (config.backend === 'cloudkit') return true;
    if (config.backend === 'file') return Boolean(config.filePath?.trim());
    if (config.backend === 'webdav') return Boolean(config.webdavUrl?.trim());
    if (config.backend === 'cloud') {
        if (config.cloudProvider === 'dropbox') {
            return Boolean(config.dropboxAppKey?.trim()) && config.isDropboxConnected === true;
        }
        return Boolean(config.cloudUrl?.trim());
    }
    return false;
};

export const getFileSyncDir = (
    syncPath: string,
    syncFileName = DEFAULT_SYNC_FILE_NAME,
    legacySyncFileName = DEFAULT_LEGACY_SYNC_FILE_NAME
): string => {
    if (!syncPath) return '';
    const trimmed = syncPath.replace(/[\\/]+$/, '');
    if (isSyncFilePath(trimmed, syncFileName, legacySyncFileName)) {
        const lastSlash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
        return lastSlash > -1 ? trimmed.slice(0, lastSlash) : '';
    }
    return trimmed;
};

export const sanitizeSyncErrorMessage = (value: string): string => {
    let result = value;
    result = result.replace(AUTH_HEADER_PATTERN, '$1$2 [redacted]');
    result = result.replace(TOKEN_PATTERN, '$1=[redacted]');
    for (const pattern of AI_KEY_PATTERNS) {
        result = result.replace(pattern, '[redacted]');
    }
    return result;
};

export const formatSyncErrorMessage = (error: unknown, backend: SyncBackend): string => {
    const raw = sanitizeSyncErrorMessage(String(error));
    if (backend === 'file') {
        if (READONLY_ERROR_PATTERN.test(raw)) {
            return 'Sync file is not writable. Re-select the sync folder in Settings -> Sync, then sync again.';
        }
        return raw;
    }
    if (backend !== 'webdav') return raw;

    const status = typeof error === 'object' && error !== null && 'status' in error
        ? Number((error as { status?: unknown }).status)
        : undefined;
    const unauthorized = status === 401 || /\(401\)/.test(raw) || /\b401\b/.test(raw);
    if (unauthorized) {
        return 'WebDAV unauthorized (401). Check folder URL, username, and app password.';
    }
    if (isWebdavRateLimitedError(error)) {
        return 'WebDAV rate limited. Sync paused briefly; try again in about a minute.';
    }
    if (raw.includes('WebDAV URL not configured')) {
        return 'WebDAV folder URL is not configured. Save WebDAV settings first.';
    }
    return raw;
};

export const isLikelyOfflineSyncError = (errorOrMessage: unknown): boolean => {
    const message = String(errorOrMessage || '');
    return OFFLINE_ERROR_PATTERNS.some((pattern) => pattern.test(message));
};
