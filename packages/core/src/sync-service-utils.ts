export type SyncBackend = 'off' | 'file' | 'webdav' | 'cloud' | 'cloudkit';

const DEFAULT_SYNC_FILE_NAME = 'data.json';
const DEFAULT_LEGACY_SYNC_FILE_NAME = 'mindwtr-sync.json';

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
