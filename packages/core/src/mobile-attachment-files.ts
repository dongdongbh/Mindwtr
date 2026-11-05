


import type { AppData, Attachment } from './types';
import { ATTACHMENTS_DIR_NAME, extractExtension } from './attachment-paths';
import { computeSha256Hex, isSha256Hex } from './attachment-hash';
import { isAttachmentPresenceStampFresh, type AttachmentPresenceStamp } from './attachment-presence-repair';
import { collectAttachmentsById, type LocalAttachmentPresence } from './attachment-transfer';
import type { LocalFileStat } from './attachment-change-detection';
import { markAttachmentUnrecoverable, preserveRefusedAttachmentContentUpload } from './attachment-validation';
import { decodeUriSafe } from './async-utils';
import { isSandboxMode } from './sandbox';
import { sanitizeAttachmentUriForSyncMerge } from './sync-normalization';
import { createWebdavDownloadBackoff } from './sync-runtime-utils';
import { readSyncLocationScope } from './sync-encryption-local-state';
import { ATTACHMENT_PRESENCE_RECONCILE_KEY, CLOUD_ALLOW_INSECURE_HTTP_KEY, CLOUD_TOKEN_KEY, CLOUD_URL_KEY, type SyncKeyValueStoragePort } from './sync-storage-keys';
import { isLikelyFilePath, loadWebDavSyncConfig, runDropboxAuthorized as runCoreDropboxAuthorized, type MobileWebDavStoredConfig } from './mobile-sync-utils';
import type { MobileCloudSyncConfig, MobileSyncDropboxAuthPort, MobileSyncLogPort } from './mobile-sync-service';

export const DEFAULT_ATTACHMENT_CONTENT_TYPE = 'application/octet-stream';
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

export const FILE_BACKEND_VALIDATION_CONFIG = {
  maxFileSizeBytes: Number.POSITIVE_INFINITY,
  blockedMimeTypes: [],
};


export const getManagedAttachmentFileName = (attachment: Pick<Attachment, 'id' | 'title' | 'uri'>): string => (
  `${attachment.id}${extractExtension(attachment.title) || extractExtension(attachment.uri)}`
);


const ATTACHMENT_UPLOAD_REFUSAL_MAX_ATTEMPTS = 3;
type AttachmentUploadRefusal = { contentIdentity: string; attempts: number };

const ATTACHMENT_TEMP_FILE_PREFIX = '.mindwtr-attachment-write-';


export type MobileAttachmentFileInfo = { exists?: boolean; isDirectory?: boolean; size?: number; modificationTime?: number };


export type MobileAttachmentSafPort = {

  readDirectory(uri: string): Promise<string[]>;

  makeDirectory(parentUri: string, name: string): Promise<string>;


  createFile?(parentUri: string, name: string, mimeType: string): Promise<string>;

  writeBytes?(uri: string, bytes: Uint8Array): Promise<void>;


  listChildren?(uri: string): Promise<{ uri: string; name: string | null; size?: number | null; mime?: string | null }[]>;

  stat?(uri: string): Promise<{ name: string | null } | null>;
};


const listSafEntries = async (saf: MobileAttachmentSafPort, dirUri: string): Promise<Map<string, { uri: string; size: number | null; directory: boolean }>> => {
  const entries = saf.listChildren
    ? await saf.listChildren(dirUri)
    : (await saf.readDirectory(dirUri)).map((uri) => ({ uri, name: null, size: null, mime: null }));
  const byName = new Map<string, { uri: string; size: number | null; directory: boolean }>();
  for (const entry of entries) {
    const name = entry.name || getSafLeafName(entry.uri);
    if (name && !byName.has(name)) {
      byName.set(name, {
        uri: entry.uri,
        size: typeof entry.size === 'number' ? entry.size : null,

        directory: entry.mime === 'vnd.android.document/directory',
      });
    }
  }
  return byName;
};


export const listSafEntriesByName = async (saf: MobileAttachmentSafPort, dirUri: string): Promise<Map<string, string>> => (
  new Map([...(await listSafEntries(saf, dirUri))].map(([name, entry]) => [name, entry.uri]))
);


export const getSafDocumentName = async (saf: MobileAttachmentSafPort, uri: string): Promise<string> => (
  (saf.stat ? (await saf.stat(uri))?.name : null) || getSafLeafName(uri)
);


export type MobileAttachmentFileSystemPort = {

  documentDirectory(): string | null;
  cacheDirectory(): string | null;
  getInfo(uri: string): Promise<MobileAttachmentFileInfo>;

  makeDirectory(uri: string): Promise<void>;

  readDirectory(uri: string): Promise<string[]>;
  readBytes(uri: string): Promise<Uint8Array>;

  readBytesRange(uri: string, position: number, length: number): Promise<Uint8Array>;

  writeBytes(uri: string, bytes: Uint8Array): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  move(from: string, to: string): Promise<void>;

  delete(uri: string): Promise<void>;


  deleteUnlessKept?(uri: string, keep: () => boolean): Promise<boolean>;

  saf(): MobileAttachmentSafPort | null;


  sha256?(uri: string): Promise<string>;
};

export type AttachmentSyncDir =
  | { type: 'file'; dirUri: string; attachmentsDirUri: string }
  | { type: 'saf'; dirUri: string; attachmentsDirUri: string };

export type AttachmentSafDirectoryEntries =
  | { status: 'available'; entries: Map<string, string>; sizes: Map<string, number | null>; directories: Set<string> }
  | { status: 'unreadable' };

export type PersistAttachmentOutcome = {
  attachment: Attachment;


  status: 'copied' | 'already-local' | 'not-applicable' | 'failed';
};

export type DropboxAccessTokenResolver = (forceRefresh: boolean) => Promise<string>;

export const isHttpAttachmentUri = (uri: string): boolean => /^https?:\/\//i.test(uri);
export const isContentAttachmentUri = (uri: string): boolean => uri.startsWith('content://');
export const getAttachmentLocalStatus = (
  uri: string,
  presence: Exclude<LocalAttachmentPresence, 'unreadable'>,
): Attachment['localStatus'] => {
  return (presence === 'present' || isHttpAttachmentUri(uri)) ? 'available' : 'missing';
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


export const toAttachmentArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer;
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const buildTempUri = (targetUri: string): string => {
  const separatorIndex = targetUri.lastIndexOf('/');
  const parent = separatorIndex >= 0 ? targetUri.slice(0, separatorIndex + 1) : '';
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`;
  return `${parent}${ATTACHMENT_TEMP_FILE_PREFIX}${suffix}.tmp`;
};


const FS_ERROR_CODE_PATTERN = /\b(EACCES|EPERM|ENOENT|ENOSPC|EEXIST|EISDIR|ENOTDIR|EROFS|EBUSY|EIO|EMFILE|ENFILE|EXDEV)\b/;

const isTempAttachmentFile = (name: string): boolean => {
  return /^\.mindwtr-attachment-write-[0-9a-z]+-[0-9a-f]{12}\.tmp$/.test(name);
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


const isTraversalFreeAttachmentUri = (uri: string): boolean =>
  Boolean(sanitizeAttachmentUriForSyncMerge(uri));


export type MobileAttachmentFilesCoreFunctions = {
  isSandboxMode: typeof isSandboxMode;
};

export type MobileAttachmentFilesHost = {
  fs: MobileAttachmentFileSystemPort;

  storage: SyncKeyValueStoragePort;

  getSecureConfigValue(key: string): Promise<string | null>;
  log: Pick<MobileSyncLogPort, 'info' | 'warn' | 'sanitize'>;

  fetch: typeof fetch;
  dropboxAuth: Pick<MobileSyncDropboxAuthPort, 'getValidAccessToken' | 'forceRefreshAccessToken'>;
  core?: Partial<MobileAttachmentFilesCoreFunctions>;
};

export const createMobileAttachmentFiles = (host: MobileAttachmentFilesHost) => {
  const core: MobileAttachmentFilesCoreFunctions = { isSandboxMode, ...host.core };
  const { fs } = host;
  const attachmentUploadRefusals = new Map<string, AttachmentUploadRefusal>();
  const webdavDownloadBackoff = createWebdavDownloadBackoff({
    missingBackoffMs: WEBDAV_ATTACHMENT_MISSING_BACKOFF_MS,
    errorBackoffMs: WEBDAV_ATTACHMENT_ERROR_BACKOFF_MS,
  });

  const attachmentContentIdentity = (attachment: Attachment): string => (
    attachment.pendingContentUpload === true
      ? attachment.fileHash?.trim().toLowerCase() ?? ''
      : ''
  );

  const matchingUploadRefusal = (attachment: Attachment): AttachmentUploadRefusal | undefined => {
    const refusal = attachmentUploadRefusals.get(attachment.id);
    if (!refusal || refusal.contentIdentity === attachmentContentIdentity(attachment)) return refusal;
    attachmentUploadRefusals.delete(attachment.id);
    return undefined;
  };

  const clearAttachmentUploadRefusal = (attachmentId: string): void => {
    attachmentUploadRefusals.delete(attachmentId);
  };

  const clearAttachmentUploadRefusals = (): void => {
    attachmentUploadRefusals.clear();
  };

  const shouldAttemptAttachmentUpload = (attachment: Attachment): boolean => (
    (matchingUploadRefusal(attachment)?.attempts ?? 0) < ATTACHMENT_UPLOAD_REFUSAL_MAX_ATTEMPTS
  );

  const handleAttachmentUploadRefusal = (
    attachment: Attachment,
    reason: string,
  ): { attempts: number; reachedLimit: boolean; mutated: boolean; message: string; logMessage: string } => {
    const contentIdentity = attachmentContentIdentity(attachment);
    const attempts = Math.min(
      (matchingUploadRefusal(attachment)?.attempts ?? 0) + 1,
      ATTACHMENT_UPLOAD_REFUSAL_MAX_ATTEMPTS,
    );
    attachmentUploadRefusals.set(attachment.id, { contentIdentity, attempts });

    const message = `Attachment upload refused (${reason}) for ${attachment.id}`
      + ` [attempt ${attempts}/${ATTACHMENT_UPLOAD_REFUSAL_MAX_ATTEMPTS}]`;
    if (attempts < ATTACHMENT_UPLOAD_REFUSAL_MAX_ATTEMPTS) {
      return { attempts, reachedLimit: false, mutated: false, message, logMessage: message };
    }
    const keepsRemoteCopy = preserveRefusedAttachmentContentUpload(attachment);
    if (keepsRemoteCopy) {
      return {
        attempts,
        reachedLimit: true,
        mutated: false,
        message,
        logMessage: `${message}; keeping the edited content pending and the remote copy unchanged`,
      };
    }
    attachmentUploadRefusals.delete(attachment.id);
    const mutated = markAttachmentUnrecoverable(attachment);
    const logMessage = `${message}; marking attachment unrecoverable`;
    return { attempts, reachedLimit: true, mutated, message, logMessage };
  };


  const describeErrorForLog = (error: unknown, knownUris: string[]): string => {
    let text = error instanceof Error ? error.message : String(error);
    for (const uri of knownUris) {
      const path = uri.replace(/^file:\/\//i, '');
      for (const form of [uri, decodeUriSafe(uri), path, decodeUriSafe(path)]) {
        if (form) text = text.split(form).join(describeAttachmentUriForLog(uri));
      }
    }


    const start = /(^|[\s'"(=:])['"]?(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|\/)/.exec(text);
    if (!start) return text;
    const code = FS_ERROR_CODE_PATTERN.exec(text.slice(start.index))?.[1];
    return `${text.slice(0, start.index)}${start[1]}[path]${code ? ` (${code})` : ''}`;
  };

  const logAttachmentWarn = (
    message: string,
    error?: unknown,
    extra?: Record<string, string>,
    knownUris: string[] = [],
  ) => {
    const fields = error
      ? {
        ...extra,
        error: host.log.sanitize(knownUris.length > 0
          ? describeErrorForLog(error, knownUris)
          : error instanceof Error ? error.message : String(error)),
      }
      : extra;
    void host.log.warn(message, { scope: 'attachment', extra: fields });
  };

  const logAttachmentInfo = (message: string, extra?: Record<string, string>) => {
    void host.log.info(message, { scope: 'attachment', extra });
  };

  const getWebdavDownloadBackoff = (attachmentId: string): number | null => {
    return webdavDownloadBackoff.getBlockedUntil(attachmentId);
  };

  const setWebdavDownloadBackoff = (attachmentId: string, error: unknown): void => {
    webdavDownloadBackoff.setFromError(attachmentId, error);
  };

  const clearWebdavDownloadBackoff = (attachmentId: string): void => {
    webdavDownloadBackoff.deleteEntry(attachmentId);
  };


  const clearWebdavDownloadBackoffs = (): void => {
    webdavDownloadBackoff.clear();
  };

  const pruneWebdavDownloadBackoff = (): void => {
    webdavDownloadBackoff.prune();
  };

  const readFileAsBytes = async (uri: string): Promise<Uint8Array> => {
    if (uri.startsWith('content://')) {
      try {
        return await fs.readBytes(uri);
      } catch (error) {
        const tempBaseDir = fs.cacheDirectory() || fs.documentDirectory();
        if (!tempBaseDir) {
          throw error;
        }
        const normalizedBaseDir = tempBaseDir.endsWith('/') ? tempBaseDir : `${tempBaseDir}/`;
        const tempUri = `${normalizedBaseDir}content-read-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.bin`;
        try {
          await fs.copy(uri, tempUri);
          return await fs.readBytes(tempUri);
        } finally {
          try {
            await fs.delete(tempUri);
          } catch {

          }
        }
      }
    }
    return await fs.readBytes(uri);
  };

  const readAttachmentBytesForUpload = async (
    uri: string
  ): Promise<{ data: Uint8Array; readFailed: false } | { data: null; readFailed: true; error: unknown }> => {
    try {
      const data = await readFileAsBytes(uri);
      return { data, readFailed: false };
    } catch (error) {
      return { data: null, readFailed: true, error };
    }
  };

  const writeBytesSafely = async (targetUri: string, bytes: Uint8Array): Promise<void> => {
    const tempUri = buildTempUri(targetUri);
    await fs.writeBytes(tempUri, bytes);
    try {
      await fs.move(tempUri, targetUri);
    } catch {
      await fs.writeBytes(targetUri, bytes);
      try {
        await fs.delete(tempUri);
      } catch {

      }
    }
  };

  const copyFileSafely = async (sourceUri: string, targetUri: string): Promise<void> => {
    const tempUri = buildTempUri(targetUri);
    const knownUris = [sourceUri, targetUri, tempUri];
    const copied = { sourceUri: describeAttachmentUriForLog(sourceUri), targetUri: describeAttachmentUriForLog(targetUri) };
    try {
      await fs.copy(sourceUri, tempUri);
    } catch (error) {
      logAttachmentWarn('Attachment temp copy failed, falling back to byte write', error, undefined, knownUris);
      await writeBytesSafely(targetUri, await readFileAsBytes(sourceUri));
      logAttachmentInfo('Attachment byte fallback copied file', copied);
      return;
    }
    try {
      await fs.move(tempUri, targetUri);
    } catch (moveError) {
      logAttachmentWarn('Attachment temp move failed, falling back to direct copy', moveError, undefined, knownUris);
      try {
        await fs.copy(sourceUri, targetUri);
      } catch (copyError) {
        logAttachmentWarn('Attachment direct copy failed, falling back to byte write', copyError, undefined, knownUris);
        await writeBytesSafely(targetUri, await readFileAsBytes(sourceUri));
        logAttachmentInfo('Attachment byte fallback copied file', copied);
      } finally {
        try {
          await fs.delete(tempUri);
        } catch {

        }
      }
    }
  };

  const runDropboxAuthorized = async <T,>(
    dropboxClientId: string,
    operation: (accessToken: string) => Promise<T>,
    fetcher: typeof fetch = host.fetch,
    resolveAccessToken?: DropboxAccessTokenResolver,
  ): Promise<T> => {
    const resolver: DropboxAccessTokenResolver = resolveAccessToken ?? ((forceRefresh) => forceRefresh
      ? host.dropboxAuth.forceRefreshAccessToken(dropboxClientId, fetcher)
      : host.dropboxAuth.getValidAccessToken(dropboxClientId, fetcher));
    return runCoreDropboxAuthorized(resolver, operation);
  };

  const loadWebDavConfig = async (): Promise<MobileWebDavStoredConfig | null> => loadWebDavSyncConfig(
    { getItem: (key) => host.storage.getItem(key) },
    (key) => host.getSecureConfigValue(key),
  );

  const loadCloudConfig = async (): Promise<MobileCloudSyncConfig | null> => {
    const [url, token, allowInsecureHttp] = await Promise.all([
      host.storage.getItem(CLOUD_URL_KEY),
      host.getSecureConfigValue(CLOUD_TOKEN_KEY),
      host.storage.getItem(CLOUD_ALLOW_INSECURE_HTTP_KEY),
    ]);
    if (!url) return null;
    return {
      url,
      token: token || '',
      allowInsecureHttp: allowInsecureHttp === 'true',
    };
  };

  const getManagedAttachmentsDir = (): string | null => {
    const base = fs.documentDirectory() || fs.cacheDirectory();
    if (!base) return null;
    const normalized = base.endsWith('/') ? base : `${base}/`;
    return `${normalized}${ATTACHMENTS_DIR_NAME}/`;
  };

  const getAttachmentsDir = async (): Promise<string | null> => {
    const dir = getManagedAttachmentsDir();
    if (!dir) return null;
    try {
      await fs.makeDirectory(dir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes('already exists')) {
        logAttachmentWarn('Failed to ensure attachments directory', error);
      }
    }
    return dir;
  };


  const deleteManagedAttachmentFile = async (
    attachment: Attachment,
    options?: { keep?: () => boolean },
  ): Promise<boolean> => {
    if (core.isSandboxMode()) return false;
    if (attachment.kind !== 'file' || !attachment.uri || !attachment.id) return false;
    const dir = await getAttachmentsDir();
    if (!dir || !attachment.uri.startsWith(dir)) return false;
    const fileName = attachment.uri.slice(dir.length).split(/[?#]/, 1)[0];
    if (!fileName || fileName.includes('/')) return false;
    if (fileName !== attachment.id && !fileName.startsWith(`${attachment.id}.`)) return false;
    if (options?.keep?.()) return false;
    try {
      if (fs.deleteUnlessKept) return await fs.deleteUnlessKept(attachment.uri, () => Boolean(options?.keep?.()));
      await fs.delete(attachment.uri);
      return true;
    } catch (error) {
      logAttachmentWarn('Failed to delete abandoned attachment draft file', error);
      return false;
    }
  };

  const cleanupAttachmentTempFiles = async (): Promise<void> => {
    const dir = await getAttachmentsDir();
    if (!dir) return;
    try {
      const entries = await fs.readDirectory(dir);
      for (const entry of entries) {
        if (!isTempAttachmentFile(entry)) continue;
        try {
          await fs.delete(`${dir}${entry}`);
        } catch (error) {
          logAttachmentWarn('Failed to remove temp attachment file', error);
        }
      }
    } catch (error) {
      logAttachmentWarn('Failed to scan temp attachment files', error);
    }
  };

  const resolveSafSyncDir = async (syncUri: string): Promise<Extract<AttachmentSyncDir, { type: 'saf' }> | null> => {
    const saf = fs.saf();
    if (!saf) return null;
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
        const entries = await listSafEntriesByName(saf, candidate);
        readableCandidates.push(candidate);
        attachmentsDirUri = entries.get(ATTACHMENTS_DIR_NAME) ?? null;
        if (attachmentsDirUri) break;
      } catch (error) {
        if (candidate === directoryCandidates[directoryCandidates.length - 1]) {
          logAttachmentWarn('Failed to read SAF directory for attachments', error);
        }
      }
    }
    if (!attachmentsDirUri) {


      if (readableCandidates.length === 0) return null;
      for (const candidate of readableCandidates) {
        try {
          attachmentsDirUri = await saf.makeDirectory(candidate, ATTACHMENTS_DIR_NAME);
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

  const resolveFileSyncDir = async (syncPath: string): Promise<AttachmentSyncDir | null> => {
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
      await fs.makeDirectory(attachmentsDirUri);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes('already exists')) {
        logAttachmentWarn('Failed to ensure sync attachments directory', error);
      }
    }
    return { type: 'file', dirUri, attachmentsDirUri };
  };

  const readSafDirectoryEntriesByName = async (dirUri: string): Promise<Map<string, string>> => {
    const entriesByName = new Map<string, string>();
    const saf = fs.saf();
    if (!saf) return entriesByName;
    try {
      for (const [name, uri] of await listSafEntriesByName(saf, dirUri)) entriesByName.set(name, uri);
    } catch (error) {
      logAttachmentWarn('Failed to read SAF directory', error);
    }
    return entriesByName;
  };


  const inspectSafDirectoryEntriesByName = async (
    dirUri: string,
  ): Promise<AttachmentSafDirectoryEntries> => {
    const saf = fs.saf();
    if (!saf) return { status: 'unreadable' };
    try {
      const listed = await listSafEntries(saf, dirUri);
      return {
        status: 'available',
        entries: new Map([...listed].map(([name, entry]) => [name, entry.uri])),
        sizes: new Map([...listed].map(([name, entry]) => [name, entry.size])),
        directories: new Set([...listed].filter(([, entry]) => entry.directory).map(([name]) => name)),
      };
    } catch (error) {
      logAttachmentWarn('Failed to read SAF directory', error);
      return { status: 'unreadable' };
    }
  };

  const findSafEntry = async (dirUri: string, fileName: string): Promise<string | null> => {
    const entriesByName = await readSafDirectoryEntriesByName(dirUri);
    return entriesByName.get(fileName) ?? null;
  };

  const getAttachmentByteSize = async (attachment: Attachment, uri: string): Promise<number | null> => {
    if (typeof attachment.size === 'number') return attachment.size;
    if (uri.startsWith('content://')) return attachment.size ?? null;
    try {
      const info = await fs.getInfo(uri);
      return info.exists && typeof info.size === 'number' ? info.size : null;
    } catch (error) {
      logAttachmentWarn('Failed to read attachment size', error);
      return attachment.size ?? null;
    }
  };

  const getLocalAttachmentPresence = async (uri: string): Promise<LocalAttachmentPresence> => {
    try {
      const info = await fs.getInfo(uri);
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


  const statAttachmentFile = async (uri: string): Promise<LocalFileStat | null> => {
    if (uri.startsWith('content://')) return null;
    try {
      const info = await fs.getInfo(uri);
      if (!info.exists || typeof info.size !== 'number' || typeof info.modificationTime !== 'number') return null;


      return { mtimeMs: Math.round(info.modificationTime * 1000), size: info.size };
    } catch (error) {
      logAttachmentWarn('Failed to stat attachment file', error);
      return null;
    }
  };

  const computeAttachmentFileHash = async (uri: string): Promise<string | null> => {
    try {
      if (fs.sha256) {
        const hex = (await fs.sha256(uri)).trim().toLowerCase();
        return isSha256Hex(hex) ? hex : null;
      }
      return await computeSha256Hex(await readFileAsBytes(uri));
    } catch (error) {
      logAttachmentWarn('Failed to hash attachment file', error);
      return null;
    }
  };


  const canUploadAttachmentFrom = (uri: string): boolean => {
    const attachmentsDir = getManagedAttachmentsDir();
    if (!attachmentsDir || !uri.startsWith(attachmentsDir)) return false;
    if (!isTraversalFreeAttachmentUri(uri)) return false;


    const leaf = uri.slice(attachmentsDir.length).split(/[?#]/, 1)[0];
    return leaf.length > 0 && !leaf.includes('/');
  };


  const describeAttachmentUriForLog = (uri?: string): string => {
    if (!uri) return 'none';
    const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(uri)?.[0] ?? '';
    const location = canUploadAttachmentFrom(uri) ? 'managed' : 'external';
    return `${scheme}${location}${extractExtension(uri.split('?')[0])}`;
  };

  const persistAttachmentLocallyDetailed = async (attachment: Attachment): Promise<PersistAttachmentOutcome> => {
    if (core.isSandboxMode()) throw new Error('Unavailable in sandbox');
    if (attachment.kind !== 'file') return { attachment, status: 'not-applicable' };
    const uri = attachment.uri || '';
    if (!uri || isHttpAttachmentUri(uri)) return { attachment, status: 'not-applicable' };
    if (!isTraversalFreeAttachmentUri(uri)) return { attachment, status: 'not-applicable' };

    const attachmentsDir = await getAttachmentsDir();
    if (!attachmentsDir) return { attachment, status: 'not-applicable' };

    if (canUploadAttachmentFrom(uri)) return { attachment, status: 'already-local' };

    const filename = getManagedAttachmentFileName({ ...attachment, uri });
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


        await copyFileSafely(uri, targetUri);
      }
      let size = attachment.size;
      if (!Number.isFinite(size ?? NaN)) {
        const info = await fs.getInfo(targetUri);
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


  const persistAttachmentLocally = async (attachment: Attachment): Promise<Attachment> => (
    (await persistAttachmentLocallyDetailed(attachment)).attachment
  );

  const ensureAttachmentStoredLocally = async (attachment: Attachment): Promise<boolean> => {
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

  const attachmentNeedsManagedLocalCopy = (attachment: Attachment): boolean => {
    if (attachment.kind !== 'file') return false;
    if (attachment.deletedAt) return false;
    const uri = attachment.uri || '';
    if (!uri || isHttpAttachmentUri(uri)) return false;
    if (!isTraversalFreeAttachmentUri(uri)) return false;
    if (!getManagedAttachmentsDir()) return false;
    return !canUploadAttachmentFrom(uri);
  };

  const createAttachmentLocalMigrationLimiter = (
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

      return { migrated, skipped: false };
    };
  };


  const readAttachmentPresenceScope = (): Promise<string | null> => readSyncLocationScope(host.storage);

  const readAttachmentPresenceStamp = async (): Promise<AttachmentPresenceStamp | null> => {
    try {
      const raw = await host.storage.getItem(ATTACHMENT_PRESENCE_RECONCILE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<AttachmentPresenceStamp> | null;
      if (typeof parsed?.scope !== 'string' || !Number.isFinite(parsed?.at)) return null;
      return { scope: parsed.scope, at: Number(parsed.at) };
    } catch {
      return null;
    }
  };


  const isAttachmentPresenceReconciliationDue = async (): Promise<boolean> => {
    const [scope, stamp] = await Promise.all([
      readAttachmentPresenceScope(),
      readAttachmentPresenceStamp(),
    ]);
    if (scope === null) return true;
    return !isAttachmentPresenceStampFresh(stamp, scope, Date.now());
  };


  const markAttachmentPresenceReconciled = async (): Promise<void> => {
    const scope = await readAttachmentPresenceScope();
    if (scope === null) return;
    try {
      const stamp: AttachmentPresenceStamp = { scope, at: Date.now() };
      await host.storage.setItem(ATTACHMENT_PRESENCE_RECONCILE_KEY, JSON.stringify(stamp));
    } catch (error) {
      logAttachmentWarn('Failed to record the attachment presence reconciliation stamp', error);
    }
  };


  const hasCompletedAttachmentPresenceReconciliation = async (): Promise<boolean> => {
    const [scope, stamp] = await Promise.all([
      readAttachmentPresenceScope(),
      readAttachmentPresenceStamp(),
    ]);
    if (scope === null) return false;
    return stamp !== null && stamp.scope === scope;
  };

  const hasPendingAttachmentSyncWork = async (
    appData: AppData,
    options: { contentCheckEnabled?: boolean } = {},
  ): Promise<boolean> => {
    if (appData.settings.attachments?.pendingRemoteDeletes?.length) return true;

    const attachmentsById = collectAttachmentsById(appData);
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

        if (attachment.localStatus !== 'downloading' && getWebdavDownloadBackoff(attachment.id) !== null) continue;
        return true;
      }


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

    if (shouldCheckManagedStorage) {
      for (const attachment of attachmentsById.values()) {
        if (attachmentNeedsManagedLocalCopy(attachment)) {
          return true;
        }
      }
    }


    return hasReconcilableSteadyState && await isAttachmentPresenceReconciliationDue();
  };

  return {
    clearAttachmentUploadRefusal,
    clearAttachmentUploadRefusals,
    shouldAttemptAttachmentUpload,
    handleAttachmentUploadRefusal,
    logAttachmentWarn,
    logAttachmentInfo,
    getWebdavDownloadBackoff,
    setWebdavDownloadBackoff,
    clearWebdavDownloadBackoff,
    clearWebdavDownloadBackoffs,
    pruneWebdavDownloadBackoff,
    readAttachmentBytesForUpload,
    writeBytesSafely,
    copyFileSafely,
    runDropboxAuthorized,
    loadWebDavConfig,
    loadCloudConfig,
    getManagedAttachmentsDir,
    getAttachmentsDir,
    deleteManagedAttachmentFile,
    cleanupAttachmentTempFiles,
    resolveFileSyncDir,
    readSafDirectoryEntriesByName,
    inspectSafDirectoryEntriesByName,
    findSafEntry,
    readFileAsBytes,
    getAttachmentByteSize,
    getLocalAttachmentPresence,
    statAttachmentFile,
    computeAttachmentFileHash,
    persistAttachmentLocallyDetailed,
    persistAttachmentLocally,
    ensureAttachmentStoredLocally,
    canUploadAttachmentFrom,
    describeAttachmentUriForLog,
    attachmentNeedsManagedLocalCopy,
    createAttachmentLocalMigrationLimiter,
    isAttachmentPresenceReconciliationDue,
    markAttachmentPresenceReconciled,
    hasCompletedAttachmentPresenceReconciliation,
    hasPendingAttachmentSyncWork,
  };
};

export type MobileAttachmentFiles = ReturnType<typeof createMobileAttachmentFiles>;
