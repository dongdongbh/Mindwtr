// The mobile apps' sync error classification and File Sync path rules. They moved here from
// React Native's `apps/mobile/lib/sync-service-utils.ts` so the native apps classify a failure
// and read a sync path exactly as React Native does. Two names differ from React Native's,
// because older core helpers already use them with other signatures: `formatMobileSyncErrorMessage`
// (React Native: `formatSyncErrorMessage`) and `isMobileSyncFilePath` (`isSyncFilePath`).
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
// A File Sync document read that could not be proven whole (short, still downloading, sizes
// that disagree): retry once the provider settles, as for a conflict.
const CONFLICT_ERROR_PATTERN = /\bconflict\b|stale remote state|precondition failed|SAF_DOCUMENT_INCOMPLETE/i;
const ENCRYPTION_STATE_ERROR_PATTERN = /SyncEncryptionStateUnavailableError/i;
// #1056. Checked BEFORE the auth pattern: "wrong passphrase" contains "passphrase", and
// several of these messages would otherwise be swallowed by AUTH_ERROR_PATTERN's
// `credentials?` alternative or by the read-only/permission pattern, producing a
// "check your sync credentials" toast for something only a passphrase prompt can fix.
const ENCRYPTION_ERROR_PATTERN =
  /SyncEncryptionNoKeyError|SyncEncryptionPartlyEncryptedError|SYNC_ENCRYPTION_PARTLY_ENCRYPTED|SyncEncryptionTerminalError|SyncEncryptionKeyMissingError|SyncEncryptionRemotePlaintextError|SyncEncryptionTransitionIncompleteError|SYNC_ENCRYPTION_TRANSITION_INCOMPLETE|sync passphrase|wrong passphrase or corrupted data|MWENC1|no longer encrypted/i;

export const formatMobileSyncErrorMessage = (error: unknown, backend: SyncBackend): string => {
  // Classified from the raw text: the log sanitizer redacts the path the temporary Inbox pattern reads.
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
  // Classified from the raw text (only a kind leaves here): the log sanitizer redacts the paths some patterns read.
  const message = String(errorOrMessage || '');
  if (!message.trim()) return 'unknown';
  if (ENCRYPTION_STATE_ERROR_PATTERN.test(message)) return 'encryptionState';
  if (ENCRYPTION_ERROR_PATTERN.test(message)) return 'encryption';
  if (isSyncFileLockUnavailableError(message)) return 'fileLockUnavailable';
  if (isCoreLikelyOfflineSyncError(message)) return 'offline';
  if (RATE_LIMIT_ERROR_PATTERN.test(message)) return 'rateLimited';
  if (AUTH_ERROR_PATTERN.test(message)) return 'auth';
  if (READONLY_ERROR_PATTERN.test(message) || IOS_TEMP_INBOX_PATTERN.test(message) || /cannot access the selected sync file/i.test(message)
    // Android File Sync's folder calls (SafDocumentsCore): the provider could not list or describe the folder.
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

/**
 * The cleartext guard core runs inside every `webdav*` call. A native streamed uploader talks
 * to the server directly, so it never reaches that guard — without this it would stream Basic
 * credentials and the file's bytes in the clear (SEC-10a). Android's
 * `cleartextTrafficPermitted="true"` is load-bearing for private-IP WebDAV (#663), so this
 * check is the enforcement point, not the platform config.
 */
export const assertMobileWebdavConnection = (url: string, allowInsecureHttp?: boolean): void => {
  assertConnectionAllowed(url, MOBILE_WEBDAV_HTTPS_ERROR, {
    ...SYNC_LOCAL_INSECURE_URL_OPTIONS,
    allowInsecureHttp: allowInsecureHttp === true,
  });
};

export type MobileWebDavStoredConfig = { url: string; username: string; password: string; allowInsecureHttp?: boolean };

/** The WebDAV sync location this device has saved, or null when no URL is saved. The password
 *  is a secret key, so it is read through the keystore. */
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

/** The Dropbox app key from a build's config extras (`extra.dropboxAppKey`), or ''. */
export const readDropboxAppKey = (extra: unknown): string => {
  const appKey = (extra as { dropboxAppKey?: unknown } | null | undefined)?.dropboxAppKey;
  return typeof appKey === 'string' ? appKey.trim() : '';
};

/** Runs `operation` with a valid Dropbox access token, and once more with a force-refreshed
 *  token when Dropbox answers unauthorized. */
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
