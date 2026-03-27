import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import type { AppData, Attachment } from '@mindwtr/core';
import {
  computeSha256Hex,
  createWebdavDownloadBackoff,
  globalProgressTracker,
} from '@mindwtr/core';
import { DropboxUnauthorizedError } from './dropbox-sync';
import {
  CLOUD_TOKEN_KEY,
  CLOUD_URL_KEY,
  WEBDAV_PASSWORD_KEY,
  WEBDAV_URL_KEY,
  WEBDAV_USERNAME_KEY,
} from './sync-constants';
import { logInfo, logWarn, sanitizeLogMessage } from './app-log';
import { isLikelyFilePath } from './sync-service-utils';

export const ATTACHMENTS_DIR_NAME = 'attachments';
export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';
export const StorageAccessFramework = (FileSystem as any).StorageAccessFramework;
export const WEBDAV_ATTACHMENT_RETRY_OPTIONS = { maxAttempts: 5, baseDelayMs: 2000, maxDelayMs: 60_000 };
export const WEBDAV_ATTACHMENT_MIN_INTERVAL_MS = 400;
export const WEBDAV_ATTACHMENT_COOLDOWN_MS = 60_000;
export const WEBDAV_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC = 10;
export const WEBDAV_ATTACHMENT_MAX_UPLOADS_PER_SYNC = 10;
export const WEBDAV_ATTACHMENT_MISSING_BACKOFF_MS = 15 * 60_000;
export const WEBDAV_ATTACHMENT_ERROR_BACKOFF_MS = 2 * 60_000;
export const DROPBOX_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC = 10;
export const DROPBOX_ATTACHMENT_MAX_UPLOADS_PER_SYNC = 10;
const webdavDownloadBackoff = createWebdavDownloadBackoff({
  missingBackoffMs: WEBDAV_ATTACHMENT_MISSING_BACKOFF_MS,
  errorBackoffMs: WEBDAV_ATTACHMENT_ERROR_BACKOFF_MS,
});
export const CLOUD_PROVIDER_DROPBOX = 'dropbox';

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

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

export const markAttachmentUnrecoverable = (attachment: Attachment): boolean => {
  const now = new Date().toISOString();
  let mutated = false;
  if (attachment.cloudKey !== undefined) {
    attachment.cloudKey = undefined;
    mutated = true;
  }
  if (attachment.fileHash !== undefined) {
    attachment.fileHash = undefined;
    mutated = true;
  }
  if (attachment.localStatus !== 'missing') {
    attachment.localStatus = 'missing';
    mutated = true;
  }
  if (!attachment.deletedAt) {
    attachment.deletedAt = now;
    mutated = true;
  }
  if (attachment.updatedAt !== now) {
    attachment.updatedAt = now;
    mutated = true;
  }
  return mutated;
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

export const reportProgress = (
  attachmentId: string,
  operation: 'upload' | 'download',
  loaded: number,
  total: number,
  status: 'active' | 'completed' | 'failed',
  error?: string
) => {
  const percentage = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
  globalProgressTracker.updateProgress(attachmentId, {
    operation,
    bytesTransferred: loaded,
    totalBytes: total,
    percentage,
    status,
    error,
  });
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

export const extractExtension = (value?: string): string => {
  if (!value) return '';
  const stripped = value.split('?')[0].split('#')[0];
  const leaf = stripped.split(/[\\/]/).pop() || '';
  const match = leaf.match(/\.[A-Za-z0-9]{1,8}$/);
  return match ? match[0].toLowerCase() : '';
};

const buildTempUri = (targetUri: string): string => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  return `${targetUri}.tmp-${suffix}`;
};

const isTempAttachmentFile = (name: string): boolean => {
  return name.includes('.tmp-') || name.endsWith('.tmp') || name.endsWith('.partial');
};

export const writeBytesSafely = async (targetUri: string, bytes: Uint8Array): Promise<void> => {
  const base64 = bytesToBase64(bytes);
  const tempUri = buildTempUri(targetUri);
  await FileSystem.writeAsStringAsync(tempUri, base64, { encoding: FileSystem.EncodingType.Base64 });
  try {
    await FileSystem.moveAsync({ from: tempUri, to: targetUri });
  } catch (error) {
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
  await FileSystem.copyAsync({ from: sourceUri, to: tempUri });
  try {
    await FileSystem.moveAsync({ from: tempUri, to: targetUri });
  } catch (error) {
    await FileSystem.copyAsync({ from: sourceUri, to: targetUri });
    try {
      await FileSystem.deleteAsync(tempUri, { idempotent: true });
    } catch {
      // Ignore cleanup errors for temp file.
    }
  }
};

export const validateAttachmentHash = async (attachment: Attachment, bytes: Uint8Array): Promise<void> => {
  const expected = attachment.fileHash;
  if (!expected || expected.length !== 64) return;
  const computed = await computeSha256Hex(bytes);
  if (!computed) return;
  if (computed.toLowerCase() !== expected.toLowerCase()) {
    throw new Error('Integrity validation failed');
  }
};

export const buildCloudKey = (attachment: Attachment): string => {
  const ext = extractExtension(attachment.title) || extractExtension(attachment.uri);
  return `${ATTACHMENTS_DIR_NAME}/${attachment.id}${ext}`;
};

export const getBaseSyncUrl = (fullUrl: string): string => {
  const trimmed = fullUrl.replace(/\/+$/, '');
  if (trimmed.toLowerCase().endsWith('.json')) {
    const lastSlash = trimmed.lastIndexOf('/');
    return lastSlash >= 0 ? trimmed.slice(0, lastSlash) : trimmed;
  }
  return trimmed;
};

export const getCloudBaseUrl = (fullUrl: string): string => {
  const trimmed = fullUrl.replace(/\/+$/, '');
  if (trimmed.toLowerCase().endsWith('/data')) {
    return trimmed.slice(0, -'/data'.length);
  }
  return trimmed;
};

export type WebDavConfig = { url: string; username: string; password: string };
export type CloudConfig = { url: string; token: string };
export type ResolvedSyncDir =
  | { type: 'file'; dirUri: string; attachmentsDirUri: string }
  | { type: 'saf'; dirUri: string; attachmentsDirUri: string };

export const isHttpAttachmentUri = (uri: string): boolean => /^https?:\/\//i.test(uri);
export const isContentAttachmentUri = (uri: string): boolean => uri.startsWith('content://');
export const getAttachmentLocalStatus = (uri: string, existsLocally: boolean): Attachment['localStatus'] => {
  return (existsLocally || isContentAttachmentUri(uri) || isHttpAttachmentUri(uri)) ? 'available' : 'missing';
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

const isDropboxUnauthorizedError = (error: unknown): boolean => {
  if (error instanceof DropboxUnauthorizedError) return true;
  const message = sanitizeLogMessage(error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes('http 401')
    || message.includes('invalid_access_token')
    || message.includes('expired_access_token')
    || message.includes('unauthorized');
};

export const runDropboxAuthorized = async <T,>(
  dropboxClientId: string,
  operation: (accessToken: string) => Promise<T>,
  fetcher: typeof fetch = fetch
): Promise<T> => {
  const {
    forceRefreshDropboxAccessToken,
    getValidDropboxAccessToken,
  } = await import('./dropbox-auth');
  let accessToken = await getValidDropboxAccessToken(dropboxClientId, fetcher);
  try {
    return await operation(accessToken);
  } catch (error) {
    if (!isDropboxUnauthorizedError(error)) throw error;
    accessToken = await forceRefreshDropboxAccessToken(dropboxClientId, fetcher);
    return operation(accessToken);
  }
};

export const loadWebDavConfig = async (): Promise<WebDavConfig | null> => {
  const url = await AsyncStorage.getItem(WEBDAV_URL_KEY);
  if (!url) return null;
  return {
    url,
    username: (await AsyncStorage.getItem(WEBDAV_USERNAME_KEY)) || '',
    password: (await AsyncStorage.getItem(WEBDAV_PASSWORD_KEY)) || '',
  };
};

export const loadCloudConfig = async (): Promise<CloudConfig | null> => {
  const url = await AsyncStorage.getItem(CLOUD_URL_KEY);
  if (!url) return null;
  return {
    url,
    token: (await AsyncStorage.getItem(CLOUD_TOKEN_KEY)) || '',
  };
};

export const getAttachmentsDir = async (): Promise<string | null> => {
  const base = FileSystem.documentDirectory || FileSystem.cacheDirectory;
  if (!base) return null;
  const normalized = base.endsWith('/') ? base : `${base}/`;
  const dir = `${normalized}${ATTACHMENTS_DIR_NAME}/`;
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
  for (const candidate of directoryCandidates) {
    try {
      const entries = await StorageAccessFramework.readDirectoryAsync(candidate);
      const decoded: Array<{ entry: string; decoded: string }> = entries.map((entry: string) => ({
        entry,
        decoded: decodeURIComponent(entry),
      }));
      const matchEntry = decoded.find((item) =>
        item.decoded.endsWith(`/${ATTACHMENTS_DIR_NAME}`) || item.decoded.endsWith(`:${ATTACHMENTS_DIR_NAME}`)
      );
      attachmentsDirUri = matchEntry?.entry ?? null;
      if (attachmentsDirUri) break;
    } catch (error) {
      if (candidate === directoryCandidates[directoryCandidates.length - 1]) {
        logAttachmentWarn('Failed to read SAF directory for attachments', error);
      }
    }
  }
  if (!attachmentsDirUri) {
    for (const candidate of directoryCandidates) {
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

export const findSafEntry = async (dirUri: string, fileName: string): Promise<string | null> => {
  if (!StorageAccessFramework?.readDirectoryAsync) return null;
  try {
    const entries = await StorageAccessFramework.readDirectoryAsync(dirUri);
    const decoded: Array<{ entry: string; decoded: string }> = entries.map((entry: string) => ({
      entry,
      decoded: decodeURIComponent(entry),
    }));
    const matchEntry = decoded.find((item) =>
      item.decoded.endsWith(`/${fileName}`) || item.decoded.endsWith(`:${fileName}`)
    );
    return matchEntry?.entry ?? null;
  } catch (error) {
    logAttachmentWarn('Failed to read SAF directory', error);
    return null;
  }
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

export const fileExists = async (uri: string): Promise<boolean> => {
  if (uri.startsWith('content://')) return true;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists;
  } catch (error) {
    logAttachmentWarn('Failed to check attachment file', error);
    return false;
  }
};

export const persistAttachmentLocally = async (attachment: Attachment): Promise<Attachment> => {
  if (attachment.kind !== 'file') return attachment;
  const uri = attachment.uri || '';
  if (!uri || isHttpAttachmentUri(uri)) return attachment;

  const attachmentsDir = await getAttachmentsDir();
  if (!attachmentsDir) return attachment;

  if (uri.startsWith(attachmentsDir)) return attachment;

  const ext = extractExtension(attachment.title) || extractExtension(uri);
  const filename = `${attachment.id}${ext}`;
  const targetUri = `${attachmentsDir}${filename}`;
  try {
    logAttachmentInfo('Cache attachment start', {
      id: attachment.id,
      title: attachment.title || 'attachment',
      uri,
      size: Number.isFinite(attachment.size ?? NaN) ? String(attachment.size) : 'unknown',
    });
    const alreadyExists = await fileExists(targetUri);
    if (!alreadyExists) {
      if (isContentAttachmentUri(uri)) {
        const bytes = await readFileAsBytes(uri);
        await writeBytesSafely(targetUri, bytes);
      } else {
        await copyFileSafely(uri, targetUri);
      }
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
      uri: targetUri,
      size: Number.isFinite(size ?? NaN) ? String(size) : 'unknown',
    });
    return {
      ...attachment,
      uri: targetUri,
      size,
      localStatus: 'available',
    };
  } catch (error) {
    logAttachmentWarn('Failed to cache attachment locally', error);
    return attachment;
  }
};

export const collectAttachments = (appData: AppData): Map<string, Attachment> => {
  const attachmentsById = new Map<string, Attachment>();
  for (const task of appData.tasks) {
    for (const attachment of task.attachments || []) {
      attachmentsById.set(attachment.id, attachment);
    }
  }
  for (const project of appData.projects) {
    for (const attachment of project.attachments || []) {
      attachmentsById.set(attachment.id, attachment);
    }
  }
  return attachmentsById;
};
