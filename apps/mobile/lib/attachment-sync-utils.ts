import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from './file-system';
import {
  ATTACHMENTS_DIR_NAME,
  buildCloudKey,
  collectAttachmentsById,
  computeSha256Hex,
  createWebdavDownloadBackoff,
  decodeUriSafe,
  extractExtension,
  getBaseSyncUrl,
  getCloudBaseUrl,
  isDropboxUnauthorizedError,
  markAttachmentUnrecoverable,
  reportProgress,
  sleep,
  validateAttachmentHash,
  type AppData,
  type Attachment,
  type LocalAttachmentPresence,
  type LocalFileStat,
} from '@mindwtr/core';
import {
  CLOUD_TOKEN_KEY,
  CLOUD_ALLOW_INSECURE_HTTP_KEY,
  CLOUD_URL_KEY,
  WEBDAV_PASSWORD_KEY,
  WEBDAV_URL_KEY,
  WEBDAV_USERNAME_KEY,
  WEBDAV_ALLOW_INSECURE_HTTP_KEY,
} from './sync-constants';
import { getSecureConfigValue } from './secure-config';
import { readActiveSyncLocationScope } from './sync-location-scope';
import { logInfo, logWarn, sanitizeLogMessage } from './app-log';
import { isLikelyFilePath } from './sync-service-utils';

export { ATTACHMENTS_DIR_NAME, buildCloudKey, extractExtension, getBaseSyncUrl, getCloudBaseUrl, reportProgress, validateAttachmentHash };
// `collectAttachments` predates `collectAttachmentsById` moving into core (packages/core/src/
// attachment-transfer.ts) — kept under its original name here so none of the 5 backend files
// need a call-site rename.
export const collectAttachments = collectAttachmentsById;
export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';
export const StorageAccessFramework = FileSystem.StorageAccessFramework;
export const WEBDAV_ATTACHMENT_RETRY_OPTIONS = { maxAttempts: 5, baseDelayMs: 2000, maxDelayMs: 60_000 };
export const WEBDAV_ATTACHMENT_MIN_INTERVAL_MS = 400;
export const WEBDAV_ATTACHMENT_COOLDOWN_MS = 60_000;
export const WEBDAV_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC = 10;
export const WEBDAV_ATTACHMENT_MAX_UPLOADS_PER_SYNC = 10;
export const WEBDAV_ATTACHMENT_MISSING_BACKOFF_MS = 15 * 60_000;
export const WEBDAV_ATTACHMENT_ERROR_BACKOFF_MS = 2 * 60_000;
export const DROPBOX_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC = 10;
export const DROPBOX_ATTACHMENT_MAX_UPLOADS_PER_SYNC = 10;
export const ATTACHMENT_LOCAL_MIGRATION_MAX_PER_SYNC = 3;
const webdavDownloadBackoff = createWebdavDownloadBackoff({
  missingBackoffMs: WEBDAV_ATTACHMENT_MISSING_BACKOFF_MS,
  errorBackoffMs: WEBDAV_ATTACHMENT_ERROR_BACKOFF_MS,
});
export const CLOUD_PROVIDER_DROPBOX = 'dropbox';

export { markAttachmentUnrecoverable, sleep };

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_LOOKUP = (() => {
  const map = new Uint8Array(256);
  map.fill(255);
  for (let i = 0; i < BASE64_ALPHABET.length; i += 1) {
    map[BASE64_ALPHABET.charCodeAt(i)] = i;
  }
  return map;
})();

export const FILE_BACKEND_VALIDATION_CONFIG = {
  maxFileSizeBytes: Number.POSITIVE_INFINITY,
  blockedMimeTypes: [],
};

export const logAttachmentWarn = (message: string, error?: unknown) => {
  const extra = error ? { error: sanitizeLogMessage(error instanceof Error ? error.message : String(error)) } : undefined;
  void logWarn(message, { scope: 'attachment', extra });
};

export const logAttachmentInfo = (message: string, extra?: Record<string, string>) => {
  void logInfo(message, { scope: 'attachment', extra });
};

export const getWebdavDownloadBackoff = (attachmentId: string): number | null => {
  return webdavDownloadBackoff.getBlockedUntil(attachmentId);
};

export const setWebdavDownloadBackoff = (attachmentId: string, error: unknown): void => {
  webdavDownloadBackoff.setFromError(attachmentId, error);
};

export const clearWebdavDownloadBackoff = (attachmentId: string): void => {
  webdavDownloadBackoff.deleteEntry(attachmentId);
};

export const pruneWebdavDownloadBackoff = (): void => {
  webdavDownloadBackoff.prune();
};

export const readAttachmentBytesForUpload = async (
  uri: string
): Promise<{ data: Uint8Array; readFailed: false } | { data: null; readFailed: true; error: unknown }> => {
  try {
    const data = await readFileAsBytes(uri);
    return { data, readFailed: false };
  } catch (error) {
    return { data: null, readFailed: true, error };
  }
};

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];

    const hasB1 = typeof b1 === 'number';
    const hasB2 = typeof b2 === 'number';
    const triplet = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);

    out += BASE64_ALPHABET[(triplet >> 18) & 0x3f];
    out += BASE64_ALPHABET[(triplet >> 12) & 0x3f];
    out += hasB1 ? BASE64_ALPHABET[(triplet >> 6) & 0x3f] : '=';
    out += hasB2 ? BASE64_ALPHABET[triplet & 0x3f] : '=';
  }
  return out;
};

export const base64ToBytes = (base64: string): Uint8Array => {
  const sanitized = base64.replace(/[^A-Za-z0-9+/=]/g, '');
  const padding = sanitized.endsWith('==') ? 2 : sanitized.endsWith('=') ? 1 : 0;
  const outputLength = Math.max(0, (sanitized.length * 3) / 4 - padding);
  const bytes = new Uint8Array(outputLength);
  let buffer = 0;
  let bits = 0;
  let index = 0;

  for (let i = 0; i < sanitized.length; i += 1) {
    const ch = sanitized.charCodeAt(i);
    if (sanitized[i] === '=') break;
    const value = BASE64_LOOKUP[ch];
    if (value === 255) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (index < bytes.length) {
        bytes[index] = (buffer >> bits) & 0xff;
      }
      index += 1;
    }
  }
  return bytes;
};

const stripUriQueryAndFragment = (value: string): string => (
  value.split('?')[0]?.split('#')[0] ?? value
);

export const getSafLeafName = (value: string): string => {
  const decoded = decodeUriSafe(value);
  const stripped = stripUriQueryAndFragment(decoded).replace(/\/+$/, '');
  const lastSeparator = Math.max(stripped.lastIndexOf('/'), stripped.lastIndexOf(':'));
  return lastSeparator >= 0 ? stripped.slice(lastSeparator + 1) : stripped;
};

const hasSafLeafName = (value: string, expected: string): boolean => (
  getSafLeafName(value) === expected
);

const ATTACHMENT_TEMP_FILE_PREFIX = '.mindwtr-attachment-write-';

const buildTempUri = (targetUri: string): string => {
  const separatorIndex = targetUri.lastIndexOf('/');
  const parent = separatorIndex >= 0 ? targetUri.slice(0, separatorIndex + 1) : '';
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`;
  return `${parent}${ATTACHMENT_TEMP_FILE_PREFIX}${suffix}.tmp`;
};

const isTempAttachmentFile = (name: string): boolean => {
  return /^\.mindwtr-attachment-write-[0-9a-z]+-[0-9a-f]{12}\.tmp$/.test(name);
};

export const writeBytesSafely = async (targetUri: string, bytes: Uint8Array): Promise<void> => {
  const base64 = bytesToBase64(bytes);
  const tempUri = buildTempUri(targetUri);
  await FileSystem.writeAsStringAsync(tempUri, base64, { encoding: FileSystem.EncodingType.Base64 });
  try {
    await FileSystem.moveAsync({ from: tempUri, to: targetUri });
  } catch {
    await FileSystem.writeAsStringAsync(targetUri, base64, { encoding: FileSystem.EncodingType.Base64 });
    try {
      await FileSystem.deleteAsync(tempUri, { idempotent: true });
    } catch {
      // Ignore cleanup errors for temp file.
    }
  }
};

export const copyFileSafely = async (sourceUri: string, targetUri: string): Promise<void> => {
  const tempUri = buildTempUri(targetUri);
  try {
    await FileSystem.copyAsync({ from: sourceUri, to: tempUri });
  } catch (error) {
    logAttachmentWarn('Attachment temp copy failed, falling back to byte write', error);
    await writeBytesSafely(targetUri, await readFileAsBytes(sourceUri));
    logAttachmentInfo('Attachment byte fallback copied file', { sourceUri, targetUri });
    return;
  }
  try {
    await FileSystem.moveAsync({ from: tempUri, to: targetUri });
  } catch (moveError) {
    logAttachmentWarn('Attachment temp move failed, falling back to direct copy', moveError);
    try {
      await FileSystem.copyAsync({ from: sourceUri, to: targetUri });
    } catch (copyError) {
      logAttachmentWarn('Attachment direct copy failed, falling back to byte write', copyError);
      await writeBytesSafely(targetUri, await readFileAsBytes(sourceUri));
      logAttachmentInfo('Attachment byte fallback copied file', { sourceUri, targetUri });
    } finally {
      try {
        await FileSystem.deleteAsync(tempUri, { idempotent: true });
      } catch {
        // Ignore cleanup errors for temp file.
      }
    }
  }
};

export type WebDavConfig = { url: string; username: string; password: string; allowInsecureHttp?: boolean };
export type CloudConfig = { url: string; token: string; allowInsecureHttp?: boolean };
export type ResolvedSyncDir =
  | { type: 'file'; dirUri: string; attachmentsDirUri: string }
  | { type: 'saf'; dirUri: string; attachmentsDirUri: string };

export const isHttpAttachmentUri = (uri: string): boolean => /^https?:\/\//i.test(uri);
export const isContentAttachmentUri = (uri: string): boolean => uri.startsWith('content://');
export const getAttachmentLocalStatus = (
  uri: string,
  presence: Exclude<LocalAttachmentPresence, 'unreadable'>,
): Attachment['localStatus'] => {
  return (presence === 'present' || isHttpAttachmentUri(uri)) ? 'available' : 'missing';
};

export const getDropboxClientId = async (): Promise<string> => {
  try {
    const constantsModule = await import('expo-constants');
    const constants = constantsModule.default as { expoConfig?: { extra?: { dropboxAppKey?: unknown } } } | undefined;
    const extra = constants?.expoConfig?.extra;
    return typeof extra?.dropboxAppKey === 'string' ? extra.dropboxAppKey.trim() : '';
  } catch {
    return '';
  }
};

export type DropboxAccessTokenResolver = (forceRefresh: boolean) => Promise<string>;

export const runDropboxAuthorized = async <T,>(
  dropboxClientId: string,
  operation: (accessToken: string) => Promise<T>,
  fetcher: typeof fetch = fetch,
  resolveAccessToken?: DropboxAccessTokenResolver,
): Promise<T> => {
  let resolver = resolveAccessToken;
  if (!resolver) {
    const {
      forceRefreshDropboxAccessToken,
      getValidDropboxAccessToken,
    } = await import('./dropbox-auth');
    resolver = (forceRefresh) => forceRefresh
      ? forceRefreshDropboxAccessToken(dropboxClientId, fetcher)
      : getValidDropboxAccessToken(dropboxClientId, fetcher);
  }

  let accessToken = await resolver(false);
  try {
    return await operation(accessToken);
  } catch (error) {
    if (!isDropboxUnauthorizedError(error)) throw error;
    accessToken = await resolver(true);
    return operation(accessToken);
  }
};

export const loadWebDavConfig = async (): Promise<WebDavConfig | null> => {
  const [url, username, password, allowInsecureHttp] = await Promise.all([
    AsyncStorage.getItem(WEBDAV_URL_KEY),
    AsyncStorage.getItem(WEBDAV_USERNAME_KEY),
    getSecureConfigValue(WEBDAV_PASSWORD_KEY),
    AsyncStorage.getItem(WEBDAV_ALLOW_INSECURE_HTTP_KEY),
  ]);
  if (!url) return null;
  return {
    url,
    username: username || '',
    password: password || '',
    allowInsecureHttp: allowInsecureHttp === 'true',
  };
};

export const loadCloudConfig = async (): Promise<CloudConfig | null> => {
  const [url, token, allowInsecureHttp] = await Promise.all([
    AsyncStorage.getItem(CLOUD_URL_KEY),
    getSecureConfigValue(CLOUD_TOKEN_KEY),
    AsyncStorage.getItem(CLOUD_ALLOW_INSECURE_HTTP_KEY),
  ]);
  if (!url) return null;
  return {
    url,
    token: token || '',
    allowInsecureHttp: allowInsecureHttp === 'true',
  };
};

const getManagedAttachmentsDir = (): string | null => {
  const base = FileSystem.documentDirectory || FileSystem.cacheDirectory;
  if (!base) return null;
  const normalized = base.endsWith('/') ? base : `${base}/`;
  return `${normalized}${ATTACHMENTS_DIR_NAME}/`;
};

export const getAttachmentsDir = async (): Promise<string | null> => {
  const dir = getManagedAttachmentsDir();
  if (!dir) return null;
  try {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes('already exists')) {
      logAttachmentWarn('Failed to ensure attachments directory', error);
    }
  }
  return dir;
};

/**
 * Removes a local attachment only when its URI proves it is the id-named copy
 * owned by Mindwtr's managed attachments directory. Draft settlement passes
 * candidates here; arbitrary user-picked paths and sibling directories are
 * intentionally rejected.
 */
export const deleteManagedAttachmentFile = async (attachment: Attachment): Promise<boolean> => {
  if (attachment.kind !== 'file' || !attachment.uri || !attachment.id) return false;
  const dir = await getAttachmentsDir();
  if (!dir || !attachment.uri.startsWith(dir)) return false;
  const fileName = attachment.uri.slice(dir.length).split(/[?#]/, 1)[0];
  if (!fileName || fileName.includes('/')) return false;
  if (fileName !== attachment.id && !fileName.startsWith(`${attachment.id}.`)) return false;
  try {
    await FileSystem.deleteAsync(attachment.uri, { idempotent: true });
    return true;
  } catch (error) {
    logAttachmentWarn('Failed to delete abandoned attachment draft file', error);
    return false;
  }
};

export const cleanupAttachmentTempFiles = async (): Promise<void> => {
  const dir = await getAttachmentsDir();
  if (!dir) return;
  try {
    const entries = await FileSystem.readDirectoryAsync(dir);
    for (const entry of entries) {
      if (!isTempAttachmentFile(entry)) continue;
      try {
        await FileSystem.deleteAsync(`${dir}${entry}`, { idempotent: true });
      } catch (error) {
        logAttachmentWarn('Failed to remove temp attachment file', error);
      }
    }
  } catch (error) {
    logAttachmentWarn('Failed to scan temp attachment files', error);
  }
};

const resolveSafSyncDir = async (syncUri: string): Promise<Extract<ResolvedSyncDir, { type: 'saf' }> | null> => {
  if (!StorageAccessFramework?.readDirectoryAsync) return null;
  const prefixMatch = syncUri.match(/^(content:\/\/[^/]+)/);
  if (!prefixMatch) return null;
  const prefix = prefixMatch[1];
  const treeMatch = syncUri.match(/\/tree\/([^/]+)/);
  let parentTreeUri: string | null = null;
  let parentDocumentUri: string | null = null;
  if (treeMatch) {
    parentTreeUri = `${prefix}/tree/${treeMatch[1]}`;
    parentDocumentUri = `${parentTreeUri}/document/${treeMatch[1]}`;
  } else {
    const docMatch = syncUri.match(/\/document\/([^/]+)/);
    if (!docMatch) return null;
    const docId = decodeURIComponent(docMatch[1]);
    const colonIndex = docId.indexOf(':');
    if (colonIndex === -1) return null;
    const volume = docId.slice(0, colonIndex + 1);
    const path = docId.slice(colonIndex + 1);
    const lastSlash = path.lastIndexOf('/');
    const parentPath = lastSlash >= 0 ? path.slice(0, lastSlash) : '';
    const parentId = parentPath ? `${volume}${parentPath}` : volume;
    const parentIdEncoded = encodeURIComponent(parentId);
    parentTreeUri = `${prefix}/tree/${parentIdEncoded}`;
    parentDocumentUri = `${parentTreeUri}/document/${parentIdEncoded}`;
  }
  if (!parentTreeUri) return null;
  const directoryCandidates = parentDocumentUri ? [parentDocumentUri, parentTreeUri] : [parentTreeUri];
  let attachmentsDirUri: string | null = null;
  const readableCandidates: string[] = [];
  for (const candidate of directoryCandidates) {
    try {
      const entries = await StorageAccessFramework.readDirectoryAsync(candidate);
      readableCandidates.push(candidate);
      const matchEntry = entries.find((entry: string) => hasSafLeafName(entry, ATTACHMENTS_DIR_NAME));
      attachmentsDirUri = matchEntry ?? null;
      if (attachmentsDirUri) break;
    } catch (error) {
      if (candidate === directoryCandidates[directoryCandidates.length - 1]) {
        logAttachmentWarn('Failed to read SAF directory for attachments', error);
      }
    }
  }
  if (!attachmentsDirUri) {
    // Creating after every inventory attempt failed can create a duplicate
    // provider document and falsely turn an unreadable remote into an empty one.
    if (readableCandidates.length === 0) return null;
    for (const candidate of readableCandidates) {
      try {
        attachmentsDirUri = await StorageAccessFramework.makeDirectoryAsync(candidate, ATTACHMENTS_DIR_NAME);
        if (attachmentsDirUri) break;
      } catch (error) {
        if (candidate === directoryCandidates[directoryCandidates.length - 1]) {
          logAttachmentWarn('Failed to create SAF attachments directory', error);
        }
      }
    }
  }
  if (!attachmentsDirUri) return null;
  return { type: 'saf', dirUri: directoryCandidates[0], attachmentsDirUri };
};

export const resolveFileSyncDir = async (syncPath: string): Promise<ResolvedSyncDir | null> => {
  if (!syncPath) return null;
  if (syncPath.startsWith('content://')) {
    const resolved = await resolveSafSyncDir(syncPath);
    if (resolved) return resolved;
    return null;
  }

  const normalized = syncPath.replace(/\/+$/, '');
  const isFilePath = isLikelyFilePath(normalized);
  const baseDir = isFilePath ? normalized.replace(/\/[^/]+$/, '') : normalized;
  if (!baseDir) return null;
  const dirUri = baseDir.endsWith('/') ? baseDir : `${baseDir}/`;
  const attachmentsDirUri = `${dirUri}${ATTACHMENTS_DIR_NAME}/`;
  try {
    await FileSystem.makeDirectoryAsync(attachmentsDirUri, { intermediates: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes('already exists')) {
      logAttachmentWarn('Failed to ensure sync attachments directory', error);
    }
  }
  return { type: 'file', dirUri, attachmentsDirUri };
};

export const readSafDirectoryEntriesByName = async (dirUri: string): Promise<Map<string, string>> => {
  const entriesByName = new Map<string, string>();
  if (!StorageAccessFramework?.readDirectoryAsync) return entriesByName;
  try {
    const entries = await StorageAccessFramework.readDirectoryAsync(dirUri);
    for (const entry of entries) {
      const name = getSafLeafName(entry);
      if (name && !entriesByName.has(name)) {
        entriesByName.set(name, entry);
      }
    }
  } catch (error) {
    logAttachmentWarn('Failed to read SAF directory', error);
  }
  return entriesByName;
};

export type SafDirectoryEntriesResult =
  | { status: 'available'; entries: Map<string, string> }
  | { status: 'unreadable' };

/** Strict SAF inventory used by mutation-capable sync. Missing capability and
 * provider errors are not equivalent to an empty directory. */
export const inspectSafDirectoryEntriesByName = async (
  dirUri: string,
): Promise<SafDirectoryEntriesResult> => {
  if (!StorageAccessFramework?.readDirectoryAsync) return { status: 'unreadable' };
  try {
    const entries = await StorageAccessFramework.readDirectoryAsync(dirUri);
    const entriesByName = new Map<string, string>();
    for (const entry of entries) {
      const name = getSafLeafName(entry);
      if (name && !entriesByName.has(name)) entriesByName.set(name, entry);
    }
    return { status: 'available', entries: entriesByName };
  } catch (error) {
    logAttachmentWarn('Failed to read SAF directory', error);
    return { status: 'unreadable' };
  }
};

export const findSafEntry = async (dirUri: string, fileName: string): Promise<string | null> => {
  const entriesByName = await readSafDirectoryEntriesByName(dirUri);
  return entriesByName.get(fileName) ?? null;
};

export const readFileAsBytes = async (uri: string): Promise<Uint8Array> => {
  if (uri.startsWith('content://')) {
    try {
      const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      return base64ToBytes(base64);
    } catch (error) {
      const tempBaseDir = FileSystem.cacheDirectory || FileSystem.documentDirectory;
      if (!tempBaseDir) {
        throw error;
      }
      const normalizedBaseDir = tempBaseDir.endsWith('/') ? tempBaseDir : `${tempBaseDir}/`;
      const tempUri = `${normalizedBaseDir}content-read-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.bin`;
      try {
        await FileSystem.copyAsync({ from: uri, to: tempUri });
        const base64 = await FileSystem.readAsStringAsync(tempUri, { encoding: FileSystem.EncodingType.Base64 });
        return base64ToBytes(base64);
      } finally {
        try {
          await FileSystem.deleteAsync(tempUri, { idempotent: true });
        } catch {
          // Ignore temp cleanup failures.
        }
      }
    }
  }
  const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  return base64ToBytes(base64);
};

export const getAttachmentByteSize = async (attachment: Attachment, uri: string): Promise<number | null> => {
  if (typeof attachment.size === 'number') return attachment.size;
  if (uri.startsWith('content://')) return attachment.size ?? null;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists && typeof info.size === 'number' ? info.size : null;
  } catch (error) {
    logAttachmentWarn('Failed to read attachment size', error);
    return attachment.size ?? null;
  }
};

export const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer;
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const isExplicitLocalFileNotFoundError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error && typeof error.code === 'string'
    ? error.code.trim().toUpperCase()
    : '';
  if (code === 'ENOENT' || code === 'ERR_FILE_NOT_FOUND' || code === 'FILE_NOT_FOUND') return true;
  const message = error instanceof Error ? error.message : '';
  return /(?:^|\b)ENOENT(?:\b|$)|no such file or directory|file not found/i.test(message);
};

export const getLocalAttachmentPresence = async (uri: string): Promise<LocalAttachmentPresence> => {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (info.exists === true) return 'present';
    if (info.exists === false) return 'confirmed-not-found';
    logAttachmentWarn('Attachment file presence was ambiguous');
    return 'unreadable';
  } catch (error) {
    if (isExplicitLocalFileNotFoundError(error)) return 'confirmed-not-found';
    logAttachmentWarn('Failed to check attachment file', error);
    return 'unreadable';
  }
};

// #1057: check-on-touch content-change detection. A `content://` (Android SAF)
// uri's mtime isn't reliably comparable across accesses, so this returns null for
// those — the per-sync pre-pass simply skips detection for them, matching the
// scope note that linked-file detection is desktop-first; SAF-backed files still
// participate fully on the re-download side via the ordinary cloudKey/hasCloudCopy
// path, unaffected by this being null.
export const statAttachmentFile = async (uri: string): Promise<LocalFileStat | null> => {
  if (uri.startsWith('content://')) return null;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists || typeof info.size !== 'number' || typeof info.modificationTime !== 'number') return null;
    // expo-file-system reports modificationTime with only whole-second resolution
    // (review S6). The recorded value is never itself transported cross-device
    // (sanitizeAppDataForRemote strips contentMtimeMs/contentSize before any sync
    // write — see sync-helpers.ts), so this coarseness can't corrupt another
    // device's view; the accepted, narrow gap is purely local: an edit that lands
    // within the same second as the last recorded stat AND preserves the exact
    // byte size is invisible to the cheap compare until a later stat call sees a
    // different second. A hash-confirming re-check (e.g. after the file is opened
    // through Mindwtr) closes that window; this cheap path alone does not.
    return { mtimeMs: Math.round(info.modificationTime * 1000), size: info.size };
  } catch (error) {
    logAttachmentWarn('Failed to stat attachment file', error);
    return null;
  }
};

export const computeAttachmentFileHash = async (uri: string): Promise<string | null> => {
  try {
    return await computeSha256Hex(await readFileAsBytes(uri));
  } catch (error) {
    logAttachmentWarn('Failed to hash attachment file', error);
    return null;
  }
};


export type PersistAttachmentOutcome = {
  attachment: Attachment;
  /**
   * 'copied' — bytes were re-homed into the managed attachments dir now;
   * 'already-local' — the uri already points into the managed dir (success);
   * 'not-applicable' — nothing to persist (link/http/non-file, or no dir);
   * 'failed' — the copy was attempted and did not succeed.
   */
  status: 'copied' | 'already-local' | 'not-applicable' | 'failed';
};

export const persistAttachmentLocallyDetailed = async (attachment: Attachment): Promise<PersistAttachmentOutcome> => {
  if (attachment.kind !== 'file') return { attachment, status: 'not-applicable' };
  const uri = attachment.uri || '';
  if (!uri || isHttpAttachmentUri(uri)) return { attachment, status: 'not-applicable' };

  const attachmentsDir = await getAttachmentsDir();
  if (!attachmentsDir) return { attachment, status: 'not-applicable' };

  if (uri.startsWith(attachmentsDir)) return { attachment, status: 'already-local' };

  const ext = extractExtension(attachment.title) || extractExtension(uri);
  const filename = `${attachment.id}${ext}`;
  const targetUri = `${attachmentsDir}${filename}`;
  try {
    logAttachmentInfo('Cache attachment start', {
      id: attachment.id,
      uri: describeAttachmentUriForLog(uri),
      size: Number.isFinite(attachment.size ?? NaN) ? String(attachment.size) : 'unknown',
    });
    const targetPresence = await getLocalAttachmentPresence(targetUri);
    if (targetPresence === 'unreadable') {
      return { attachment, status: 'failed' };
    }
    if (targetPresence === 'confirmed-not-found') {
      // copyFileSafely streams through native copyAsync (temp + rename) and
      // only falls back to the JS byte round-trip when the provider refuses
      // the copy — content:// sources included, so share-sheet files avoid a
      // double base64 pass on the JS thread.
      await copyFileSafely(uri, targetUri);
    }
    let size = attachment.size;
    if (!Number.isFinite(size ?? NaN)) {
      const info = await FileSystem.getInfoAsync(targetUri);
      if (info.exists && typeof info.size === 'number') {
        size = info.size;
      }
    }
    logAttachmentInfo('Cache attachment done', {
      id: attachment.id,
      uri: describeAttachmentUriForLog(targetUri),
      size: Number.isFinite(size ?? NaN) ? String(size) : 'unknown',
    });
    return {
      attachment: {
        ...attachment,
        uri: targetUri,
        size,
        localStatus: 'available',
      },
      status: 'copied',
    };
  } catch (error) {
    logAttachmentWarn('Failed to cache attachment locally', error);
    return { attachment, status: 'failed' };
  }
};

// Compatibility shape: callers that only need the (possibly re-homed)
// attachment. Note the ambiguity — an unchanged result can mean failure OR
// already-managed; callers that must tell them apart use the Detailed variant.
export const persistAttachmentLocally = async (attachment: Attachment): Promise<Attachment> => (
  (await persistAttachmentLocallyDetailed(attachment)).attachment
);

export const ensureAttachmentStoredLocally = async (attachment: Attachment): Promise<boolean> => {
  if (attachment.kind !== 'file') return false;
  if (attachment.deletedAt) return false;

  const cached = await persistAttachmentLocally(attachment);
  if (
    cached.uri === attachment.uri
    && cached.size === attachment.size
    && cached.localStatus === attachment.localStatus
  ) {
    return false;
  }

  attachment.uri = cached.uri;
  attachment.size = cached.size;
  attachment.localStatus = cached.localStatus;
  return true;
};

/**
 * SEC-07: which local uris this device may read bytes from for sync. An attachment `uri`
 * travels inside the synced document and survives the merge sanitizer, so without this a
 * hostile sync document makes the next cycle upload an arbitrary local file to the remote.
 * `migrateAttachmentsLocallyBeforeSync` runs first and copies every legitimate outside
 * file (legacy content:// / SAF references) into the managed dir; whatever is still
 * outside afterwards is refused rather than read.
 */
export const canUploadAttachmentFrom = (uri: string): boolean => {
  const attachmentsDir = getManagedAttachmentsDir();
  if (!attachmentsDir) return false;
  return uri.startsWith(attachmentsDir);
};

/**
 * A uri is task content — the file name is the user's (#854: ids and field names only).
 * Log the scheme, whether the file sits in our own storage, and the extension; those are
 * what every attachment bug so far actually needed, and none of them is user text.
 */
export const describeAttachmentUriForLog = (uri?: string): string => {
  if (!uri) return 'none';
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(uri)?.[0] ?? '';
  const location = canUploadAttachmentFrom(uri) ? 'managed' : 'external';
  return `${scheme}${location}${extractExtension(uri.split('?')[0])}`;
};

export const attachmentNeedsManagedLocalCopy = (attachment: Attachment): boolean => {
  if (attachment.kind !== 'file') return false;
  if (attachment.deletedAt) return false;
  const uri = attachment.uri || '';
  if (!uri || isHttpAttachmentUri(uri)) return false;
  const attachmentsDir = getManagedAttachmentsDir();
  if (!attachmentsDir) return false;
  return !uri.startsWith(attachmentsDir);
};

export const createAttachmentLocalMigrationLimiter = (
  maxMigrations = ATTACHMENT_LOCAL_MIGRATION_MAX_PER_SYNC
): ((attachment: Attachment) => Promise<{ migrated: boolean; skipped: boolean }>) => {
  let migrationAttempts = 0;
  let limitLogged = false;

  return async (attachment: Attachment): Promise<{ migrated: boolean; skipped: boolean }> => {
    if (!attachmentNeedsManagedLocalCopy(attachment)) {
      return { migrated: false, skipped: false };
    }
    if (migrationAttempts >= maxMigrations) {
      if (!limitLogged) {
        logAttachmentInfo('Attachment local migration limit reached', {
          limit: String(maxMigrations),
        });
        limitLogged = true;
      }
      return { migrated: false, skipped: true };
    }

    migrationAttempts += 1;
    const migrated = await ensureAttachmentStoredLocally(attachment);
    // If migration failed but the original URI is still readable, the backend can upload from it.
    return { migrated, skipped: false };
  };
};

/** Once a day. Attachment bytes are immutable once uploaded, so the only thing a
 *  presence pass can still discover is someone deleting files behind the app's back. */
export const ATTACHMENT_PRESENCE_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ATTACHMENT_PRESENCE_RECONCILE_KEY = '@mindwtr_attachment_presence_reconcile_v1';

type AttachmentPresenceStamp = { scope: string; at: number };

/**
 * Identity of the place attachments live: the backend plus the location/account that
 * decides which remote a `cloudKey` points at. Read from device config rather than passed
 * in, so `hasPendingAttachmentSyncWork` keeps its `(appData, options)` signature and the
 * two gates that consult it (that predicate, and each backend's own presence pass) can
 * never disagree about what "the same backend configuration" means.
 *
 * Shared with sync-encryption discovery scoping (#1138) via `readActiveSyncLocationScope`
 * so the two features can never disagree about what "the same sync location" means. That
 * helper normalizes URLs where this one used raw values, so the first run after upgrading
 * sees a changed scope and reconciles once — exactly the "don't know" path below.
 */
const readAttachmentPresenceScope = readActiveSyncLocationScope;

const readAttachmentPresenceStamp = async (): Promise<AttachmentPresenceStamp | null> => {
  try {
    const raw = await AsyncStorage.getItem(ATTACHMENT_PRESENCE_RECONCILE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AttachmentPresenceStamp> | null;
    if (typeof parsed?.scope !== 'string' || !Number.isFinite(parsed?.at)) return null;
    return { scope: parsed.scope, at: Number(parsed.at) };
  } catch {
    return null;
  }
};

/**
 * #1119 follow-up: should the full per-attachment reconciliation pass run now?
 *
 * An uploaded attachment's remote key is derived from its id and its bytes never change,
 * so re-proving presence on every cycle re-establishes something already known — at the
 * cost of a MKCOL, one HEAD per attachment and three native stats per attachment on every
 * idle cycle, plus whatever the phase running at all costs upstream. The proof is still
 * worth having, because a user can delete files on the server directly; it is not worth
 * having hourly.
 *
 * Due when: nothing has ever reconciled, the stamp is unreadable, the backend
 * configuration changed under it, it is older than a day, or the clock moved backwards
 * since it was written. Each of those is "don't know", and every "don't know" reconciles.
 */
export const isAttachmentPresenceReconciliationDue = async (): Promise<boolean> => {
  const [scope, stamp] = await Promise.all([
    readAttachmentPresenceScope(),
    readAttachmentPresenceStamp(),
  ]);
  if (scope === null || !stamp || stamp.scope !== scope) return true;
  const elapsed = Date.now() - stamp.at;
  return elapsed < 0 || elapsed >= ATTACHMENT_PRESENCE_RECONCILE_INTERVAL_MS;
};

/**
 * Records that a full per-attachment pass just ran to completion against the current
 * backend configuration. Called by each backend at the end of its own pass rather than by
 * the predicate above, so a pass that never ran (or aborted) leaves the stamp alone and the
 * next cycle retries instead of parking the reconciliation for a day.
 */
export const markAttachmentPresenceReconciled = async (): Promise<void> => {
  const scope = await readAttachmentPresenceScope();
  if (scope === null) return;
  try {
    const stamp: AttachmentPresenceStamp = { scope, at: Date.now() };
    await AsyncStorage.setItem(ATTACHMENT_PRESENCE_RECONCILE_KEY, JSON.stringify(stamp));
  } catch (error) {
    logAttachmentWarn('Failed to record the attachment presence reconciliation stamp', error);
  }
};

/**
 * fresh-join-attachment-posture packet -10 (correction pass, fixed in the final fix pass —
 * review finding B2): the durable "this device has completed at least one full cycle against
 * the active location" fact for backends with no `FastSyncState` record — the file backend
 * above all, since `buildFastSyncScope` returns `null` for it and always will. A presence
 * stamp is only ever written at the END of a completed attachment pass
 * (`markAttachmentPresenceReconciled`, called by each backend's own presence loop), so its
 * existence — for THIS exact scope — proves a full cycle already ran here, which is all the
 * sync-encryption posture gate needs to stop treating a fresh join as "already known safe".
 * Scope-exact on purpose: a stamp from a previous location must not vouch for a new one.
 *
 * Takes NO scope argument on purpose: it derives the comparison scope itself via
 * `readAttachmentPresenceScope` (= `readActiveSyncLocationScope`), the exact same derivation
 * `markAttachmentPresenceReconciled` uses to write the stamp. B2 caught a caller passing
 * `sync-service.ts`'s `this.locationScope` (built from the RESOLVED file path, e.g. with
 * `/data.json` appended in memory for an iOS folder bookmark) instead — the two derivations
 * disagree for that exact configuration, so the stamp compared unequal forever and this gate
 * never established. Deriving the scope in the one place that also writes it makes the two
 * sides symmetric by construction; no caller can reintroduce the mismatch.
 */
export const hasCompletedAttachmentPresenceReconciliation = async (): Promise<boolean> => {
  const [scope, stamp] = await Promise.all([
    readAttachmentPresenceScope(),
    readAttachmentPresenceStamp(),
  ]);
  if (scope === null) return false;
  return stamp !== null && stamp.scope === scope;
};

export const hasPendingAttachmentSyncWork = async (
  appData: AppData,
  options: { contentCheckEnabled?: boolean } = {},
): Promise<boolean> => {
  if (appData.settings.attachments?.pendingRemoteDeletes?.length) return true;

  const attachmentsById = collectAttachments(appData);
  let shouldCheckManagedStorage = false;
  let hasReconcilableSteadyState = false;

  for (const attachment of attachmentsById.values()) {
    if (attachment.kind !== 'file') continue;
    if (attachment.deletedAt) continue;

    const uri = attachment.uri || '';
    const isHttp = isHttpAttachmentUri(uri);
    const hasLocalUri = Boolean(uri) && !isHttp;
    if (!attachment.cloudKey && hasLocalUri && attachment.localStatus !== 'missing') {
      return true;
    }
    if (attachment.cloudKey && hasLocalUri && attachment.localStatus === undefined) {
      return true;
    }
    if (attachment.cloudKey && (!uri || attachment.localStatus === 'missing' || attachment.localStatus === 'downloading')) {
      return true;
    }
    // #1057 (review B3): the steady state — cloudKey + a managed local file +
    // localStatus 'available' — used to fall all the way through to "no pending
    // work", which is exactly the case check-on-touch content detection exists to
    // catch (an edited-in-place file, or another device's newer upload). Only
    // counted as pending when the caller's backend actually wires content
    // detection; the lifecycle's own cheap mtime/size compare is the real cost
    // gate, this is just what lets the phase run at all.
    //
    // #1119 follow-up (audit F3): that made EVERY cycle run the whole phase for
    // anyone owning one synced attachment. Two things genuinely need the phase from
    // this state, and each now has its own signal rather than "always":
    //
    //  - another device's newer content. `resolveContentIdentity` in core's merge
    //    (packages/core/src/sync.ts) lands an incoming content winner with NO
    //    recorded contentMtimeMs/contentSize, precisely so the receiving device
    //    re-checks and re-downloads. An absent recorded stat is therefore the
    //    download signal, and it is already in the document — no local stat, no
    //    request, no file bytes read.
    //  - the remote copy deleted on the server behind the app's back. Nothing local
    //    can show that, so it stays a real pass — just a periodic one.
    //
    // What is deliberately no longer detected within one cycle is a managed local
    // file edited in place. Mobile has no path that does that: managed attachment
    // files live in app-private storage and are only ever created (capture) or
    // replaced by a download that re-records the stat in the same breath. The daily
    // pass still catches it.
    if (options.contentCheckEnabled && attachment.cloudKey && hasLocalUri && attachment.localStatus === 'available') {
      if (
        attachment.pendingContentUpload === true
        || !Number.isFinite(attachment.contentMtimeMs ?? NaN)
        || !Number.isFinite(attachment.contentSize ?? NaN)
      ) {
        return true;
      }
      hasReconcilableSteadyState = true;
    }
    if (hasLocalUri) {
      shouldCheckManagedStorage = true;
    }
  }

  const attachmentsDir = shouldCheckManagedStorage ? getManagedAttachmentsDir() : null;
  if (attachmentsDir) {
    for (const attachment of attachmentsById.values()) {
      if (attachment.kind !== 'file') continue;
      if (attachment.deletedAt) continue;
      const uri = attachment.uri || '';
      if (!uri || isHttpAttachmentUri(uri)) continue;
      if (!uri.startsWith(attachmentsDir)) {
        return true;
      }
    }
  }

  // Nothing in the document says there is work to do. The one remaining reason to run the
  // phase is the periodic presence proof — and only when there is something to prove, so a
  // library with no settled attachments never reads device config at all.
  return hasReconcilableSteadyState && await isAttachmentPresenceReconciliationDue();
};
