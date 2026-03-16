import { getFileSyncDir, isSyncFilePath as isCoreSyncFilePath, isWebdavRateLimitedError, normalizeSyncBackend, type SyncBackend as CoreSyncBackend } from '@mindwtr/core';

export type SyncBackend = CoreSyncBackend | 'cloudkit';

const SYNC_FILE_NAME = 'data.json';
const LEGACY_SYNC_FILE_NAME = 'mindwtr-sync.json';
const FILE_EXTENSION_PATTERN = /\.[A-Za-z0-9]{1,16}$/;
const AI_KEY_PATTERNS = [
  /sk-[A-Za-z0-9]{10,}/g,
  /sk-ant-[A-Za-z0-9]{10,}/g,
  /rk-[A-Za-z0-9]{10,}/g,
  /AIza[0-9A-Za-z\-_]{10,}/g,
];
const TOKEN_PATTERN = /(password|pass|token|access_token|api_key|apikey|authorization|username|user|secret|session|cookie)=([^\s&]+)/gi;
const AUTH_HEADER_PATTERN = /(Authorization:\s*)(Basic|Bearer)\s+[A-Za-z0-9+\/=._-]+/gi;
const READONLY_ERROR_PATTERN = /isn't writable|not writable|read-only|read only|permission denied|EACCES/i;
const IOS_TEMP_INBOX_PATTERN = /\/tmp\/[^/\s]*-Inbox\//i;
const IOS_ABSOLUTE_PATH_PATTERN = /^\/(private\/)?var\/mobile\//i;
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

const sanitizeMessage = (value: string): string => {
  let result = value;
  result = result.replace(AUTH_HEADER_PATTERN, '$1$2 [redacted]');
  result = result.replace(TOKEN_PATTERN, '$1=[redacted]');
  for (const pattern of AI_KEY_PATTERNS) {
    result = result.replace(pattern, '[redacted]');
  }
  return result;
};

export const formatSyncErrorMessage = (error: unknown, backend: SyncBackend): string => {
  const raw = sanitizeMessage(String(error));
  if (backend === 'file') {
    if (IOS_TEMP_INBOX_PATTERN.test(raw) && READONLY_ERROR_PATTERN.test(raw)) {
      return 'Selected iOS sync file is a temporary Files copy. Google Drive and OneDrive are not reliable for file sync here yet. Use iCloud Drive or WebDAV instead.';
    }
    if (READONLY_ERROR_PATTERN.test(raw)) {
      return 'Sync file is not writable. Re-select the sync folder in Settings -> Data & Sync, then sync again.';
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

export const isSyncFilePath = (path: string) => isCoreSyncFilePath(path, SYNC_FILE_NAME, LEGACY_SYNC_FILE_NAME);

const stripPathQueryAndFragment = (value: string): string => value.split('?')[0]?.split('#')[0] ?? value;

export const isLikelyFilePath = (path: string): boolean => {
  if (!path) return false;
  const stripped = stripPathQueryAndFragment(path).replace(/[\\/]+$/, '');
  if (!stripped) return false;
  if (isSyncFilePath(stripped)) return true;
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

export const isRemoteSyncBackend = (backend: SyncBackend): boolean =>
  backend === 'webdav' || backend === 'cloud' || backend === 'cloudkit';

export const resolveBackend = (value: string | null): SyncBackend => {
  if (value === 'cloudkit') return 'cloudkit';
  return normalizeSyncBackend(value);
};
