


import {
  formatSyncErrorMessage as formatCoreSyncErrorMessage,
  getFileSyncDir,
  coerceSupportedSyncBackend,
  isLikelyOfflineSyncError as isCoreLikelyOfflineSyncError,
  isSyncFileGenerationCorruptError,
  isSyncFileLockUnavailableError,
  isSyncFilePath as isCoreSyncFilePath,
  LEGACY_SYNC_FILE_NAME,
  resolveSyncBackend,
  SYNC_FILE_NAME,
  type SyncBackend as CoreSyncBackend,
} from './sync-service-utils';
import { summarizeMergeStats } from './sync-log-utils';
import type { MergeStats } from './sync-types';
import { isDropboxUnauthorizedError } from './dropbox';
import { assertConnectionAllowed, SYNC_LOCAL_INSECURE_URL_OPTIONS } from './http-utils';
import {
  WEBDAV_ALLOW_INSECURE_HTTP_KEY,
  WEBDAV_PASSWORD_KEY,
  WEBDAV_URL_KEY,
  WEBDAV_USERNAME_KEY,
  type SyncKeyValueStoragePort,
} from './sync-storage-keys';

type SyncBackend = CoreSyncBackend;
export type SyncFailureKind =
  | 'offline'
  | 'auth'
  | 'permission'
  | 'rateLimited'
  | 'misconfigured'
  | 'conflict'
  | 'encryptionState'
  | 'encryption'
  | 'fileGenerationCorrupt'
  | 'fileLockUnavailable'
  | 'unknown';

const FILE_EXTENSION_PATTERN = /\.[A-Za-z0-9]{1,16}$/;
const READONLY_ERROR_PATTERN = /isn't writable|not writable|read-only|read only|permission denied|EACCES/i;
const IOS_TEMP_INBOX_PATTERN = /\/tmp\/[^/\s]*-Inbox\//i;
const IOS_ABSOLUTE_PATH_PATTERN = /^\/(private\/)?var\/mobile\//i;
const AUTH_ERROR_PATTERN = /\b401\b|unauthori[sz]ed|forbidden|\b403\b|reauth|re-auth|app password|credentials?/i;
const RATE_LIMIT_ERROR_PATTERN = /\b429\b|rate limit|too many requests|retry after/i;
const MISCONFIGURED_SYNC_PATTERN = /not configured|missing .*config|save .*settings first|finish setup/i;
const SAF_UNAVAILABLE_ERROR_PATTERN = /SAF_DOCUMENTS?_UNAVAILABLE/;


const CONFLICT_ERROR_PATTERN = /\bconflict\b|stale remote state|precondition failed|SAF_DOCUMENT_INCOMPLETE/i;
const ENCRYPTION_STATE_ERROR_PATTERN = /SyncEncryptionStateUnavailableError/i;


const ENCRYPTION_ERROR_PATTERN =
  /SyncEncryptionNoKeyError|SyncEncryptionPartlyEncryptedError|SYNC_ENCRYPTION_PARTLY_ENCRYPTED|SyncEncryptionTerminalError|SyncEncryptionKeyMissingError|SyncEncryptionRemotePlaintextError|SyncEncryptionTransitionIncompleteError|SYNC_ENCRYPTION_TRANSITION_INCOMPLETE|sync passphrase|wrong passphrase or corrupted data|MWENC1|no longer encrypted/i;

export const formatMobileSyncErrorMessage = (error: unknown, backend: SyncBackend): string => {

  const raw = String(error);
  if (backend === 'file') {
    if (IOS_TEMP_INBOX_PATTERN.test(raw) && READONLY_ERROR_PATTERN.test(raw)) {
      return 'Selected iOS sync file is a temporary Files copy. Re-select it in Settings → Sync so Mindwtr can store durable access, or use iCloud Drive or WebDAV instead.';
    }
  }
  return formatCoreSyncErrorMessage(error, backend);
};

export const classifySyncFailure = (errorOrMessage: unknown): SyncFailureKind => {
  if (isSyncFileGenerationCorruptError(errorOrMessage)) return 'fileGenerationCorrupt';

  const message = String(errorOrMessage || '');
  if (!message.trim()) return 'unknown';
  if (ENCRYPTION_STATE_ERROR_PATTERN.test(message)) return 'encryptionState';
  if (ENCRYPTION_ERROR_PATTERN.test(message)) return 'encryption';
  if (isSyncFileLockUnavailableError(message)) return 'fileLockUnavailable';
  if (isCoreLikelyOfflineSyncError(message)) return 'offline';
  if (RATE_LIMIT_ERROR_PATTERN.test(message)) return 'rateLimited';
  if (AUTH_ERROR_PATTERN.test(message)) return 'auth';
  if (READONLY_ERROR_PATTERN.test(message) || IOS_TEMP_INBOX_PATTERN.test(message) || /cannot access the selected sync file/i.test(message)

    || SAF_UNAVAILABLE_ERROR_PATTERN.test(message)) {
    return 'permission';
  }
  if (MISCONFIGURED_SYNC_PATTERN.test(message)) return 'misconfigured';
  if (CONFLICT_ERROR_PATTERN.test(message)) return 'conflict';
  return 'unknown';
};

export const normalizeFileSyncPath = (path: string, platformOs: string): string => {
  const trimmed = path.trim();
  if (!trimmed) return trimmed;
  if (platformOs !== 'ios') return trimmed;
  if (trimmed.startsWith('content://')) return trimmed;
  if (trimmed.startsWith('file://')) return trimmed;
  if (IOS_ABSOLUTE_PATH_PATTERN.test(trimmed)) {
    return `file://${trimmed}`;
  }
  return trimmed;
};

export const isMobileSyncFilePath = (path: string) => isCoreSyncFilePath(path, SYNC_FILE_NAME, LEGACY_SYNC_FILE_NAME);

const stripPathQueryAndFragment = (value: string): string => value.split('?')[0]?.split('#')[0] ?? value;

export const isLikelyFilePath = (path: string): boolean => {
  if (!path) return false;
  const stripped = stripPathQueryAndFragment(path).replace(/[\\/]+$/, '');
  if (!stripped) return false;
  if (isMobileSyncFilePath(stripped)) return true;
  const lastSlash = Math.max(stripped.lastIndexOf('/'), stripped.lastIndexOf('\\'));
  if (lastSlash < 0 || lastSlash >= stripped.length - 1) return false;
  const leaf = stripped.slice(lastSlash + 1);
  return FILE_EXTENSION_PATTERN.test(leaf);
};

export const getFileSyncBaseDir = (syncPath: string) => {
  if (!isLikelyFilePath(syncPath)) {
    return getFileSyncDir(syncPath, SYNC_FILE_NAME, LEGACY_SYNC_FILE_NAME);
  }
  const stripped = stripPathQueryAndFragment(syncPath).replace(/[\\/]+$/, '');
  const lastSlash = Math.max(stripped.lastIndexOf('/'), stripped.lastIndexOf('\\'));
  return lastSlash > -1 ? stripped.slice(0, lastSlash) : '';
};

export const resolveBackend = (value: string | null): SyncBackend => resolveSyncBackend(value);

export const coerceSupportedBackend = (backend: SyncBackend, allowCloudKit: boolean): SyncBackend =>
  coerceSupportedSyncBackend(backend, { allowCloudKit });

const collectConflictIds = (stats?: MergeStats | null): string[] => {
  return summarizeMergeStats(stats).conflictIds.sort();
};

export const getSyncConflictCount = (stats?: MergeStats | null): number => (
  summarizeMergeStats(stats).conflicts
);

export const getSyncTimestampAdjustments = (stats?: MergeStats | null): number => (
  summarizeMergeStats(stats).timestampAdjustments
);

export const getSyncMaxClockSkewMs = (stats?: MergeStats | null): number => (
  summarizeMergeStats(stats).maxClockSkewMs
);

export const hasSameUserFacingSyncConflictSummary = (
  currentStats?: MergeStats | null,
  previousStats?: MergeStats | null,
): boolean => {
  const currentConflictCount = getSyncConflictCount(currentStats);
  if (currentConflictCount === 0) return false;
  if (currentConflictCount !== getSyncConflictCount(previousStats)) return false;
  if (getSyncMaxClockSkewMs(currentStats) !== getSyncMaxClockSkewMs(previousStats)) return false;
  if (getSyncTimestampAdjustments(currentStats) !== getSyncTimestampAdjustments(previousStats)) return false;
  const currentConflictIds = collectConflictIds(currentStats);
  const previousConflictIds = collectConflictIds(previousStats);
  return JSON.stringify(currentConflictIds) === JSON.stringify(previousConflictIds);
};

export const getMobileWebDavRequestOptions = (allowInsecureHttp?: boolean) => (
  allowInsecureHttp === true ? { allowInsecureHttp: true } : {}
);

export const getMobileCloudRequestOptions = (allowInsecureHttp?: boolean) => (
  allowInsecureHttp === true ? { allowInsecureHttp: true } : {}
);

const MOBILE_WEBDAV_HTTPS_ERROR =
  'WebDAV requires HTTPS for public URLs (HTTP allowed for localhost, private IPs, and local hostnames).';


export const assertMobileWebdavConnection = (url: string, allowInsecureHttp?: boolean): void => {
  assertConnectionAllowed(url, MOBILE_WEBDAV_HTTPS_ERROR, {
    ...SYNC_LOCAL_INSECURE_URL_OPTIONS,
    allowInsecureHttp: allowInsecureHttp === true,
  });
};

export type MobileWebDavStoredConfig = { url: string; username: string; password: string; allowInsecureHttp?: boolean };


export const loadWebDavSyncConfig = async (
  storage: Pick<SyncKeyValueStoragePort, 'getItem'>,
  getSecureConfigValue: (key: string) => Promise<string | null>,
): Promise<MobileWebDavStoredConfig | null> => {
  const [url, username, password, allowInsecureHttp] = await Promise.all([
    storage.getItem(WEBDAV_URL_KEY),
    storage.getItem(WEBDAV_USERNAME_KEY),
    getSecureConfigValue(WEBDAV_PASSWORD_KEY),
    storage.getItem(WEBDAV_ALLOW_INSECURE_HTTP_KEY),
  ]);
  if (!url) return null;
  return {
    url,
    username: username || '',
    password: password || '',
    allowInsecureHttp: allowInsecureHttp === 'true',
  };
};


export const readDropboxAppKey = (extra: unknown): string => {
  const appKey = (extra as { dropboxAppKey?: unknown } | null | undefined)?.dropboxAppKey;
  return typeof appKey === 'string' ? appKey.trim() : '';
};


export const runDropboxAuthorized = async <T>(
  resolveAccessToken: (forceRefresh: boolean) => Promise<string>,
  operation: (accessToken: string) => Promise<T>,
): Promise<T> => {
  let accessToken = await resolveAccessToken(false);
  try {
    return await operation(accessToken);
  } catch (error) {
    if (!isDropboxUnauthorizedError(error)) throw error;
    accessToken = await resolveAccessToken(true);
    return operation(accessToken);
  }
};
