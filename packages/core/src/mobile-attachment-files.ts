// The mobile attachment files layer: where attachment bytes live on the device, safe
// temp-then-rename writes, local presence and stat, the per-session upload-refusal budget, the
// WebDAV download backoff, the stored sync configs, the once-a-day presence stamp (#1119) and
// the pending-work predicate. It moved here from React Native's
// `apps/mobile/lib/attachment-sync-utils.ts` so the native apps run the same rules; each host
// binds it to its own file IO, key-value store, keystore, Dropbox credentials and log.
//
// Data safety: attachment bytes stay under `<documents>/attachments/` (`ATTACHMENTS_DIR_NAME`),
// so every stored `file://` URI stays valid, and a write goes to a temp file first so a cut
// write never leaves a truncated file at the real path.
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
import { CLOUD_ALLOW_INSECURE_HTTP_KEY, CLOUD_TOKEN_KEY, CLOUD_URL_KEY, type SyncKeyValueStoragePort } from './sync-storage-keys';
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

/** The existing managed filename policy only. This does not validate an ID/path or prove
 * ownership, and callers must still authorize the directory and any file operation. */
export const getManagedAttachmentFileName = (attachment: Pick<Attachment, 'id' | 'title' | 'uri'>): string => (
  `${attachment.id}${extractExtension(attachment.title) || extractExtension(attachment.uri)}`
);

// A per-session count of permanent upload refusals (the mobile twin of desktop's
// sync-attachment-validation.ts). A third first-upload refusal is terminal; a replacement
// remains pending and suppresses further attempts for the same content identity.
const ATTACHMENT_UPLOAD_REFUSAL_MAX_ATTEMPTS = 3;
type AttachmentUploadRefusal = { contentIdentity: string; attempts: number };

const ATTACHMENT_PRESENCE_RECONCILE_KEY = '@mindwtr_attachment_presence_reconcile_v1';
const ATTACHMENT_TEMP_FILE_PREFIX = '.mindwtr-attachment-write-';

/** What the host's file system reports for a path. `exists` stays undefined when the platform
 *  cannot tell; `modificationTime` is in seconds, as expo-file-system reports it. */
export type MobileAttachmentFileInfo = { exists?: boolean; size?: number; modificationTime?: number };

/** Android Storage Access Framework folders (`content://` trees). */
export type MobileAttachmentSafPort = {
  /** The entry URIs of a folder. */
  readDirectory(uri: string): Promise<string[]>;
  /** Creates a subfolder and returns its URI. */
  makeDirectory(parentUri: string, name: string): Promise<string>;
  /** Creates a document and returns its URI; a provider may rename it on a name clash.
   *  Absent where the host cannot write SAF folders: File Sync then refuses the upload. */
  createFile?(parentUri: string, name: string, mimeType: string): Promise<string>;
  /** Replaces a document's bytes. */
  writeBytes?(uri: string, bytes: Uint8Array): Promise<void>;
};

/** The device's file IO for attachments (React Native: expo-file-system). URIs pass through
 *  verbatim, scheme included (`file://`, Android `content://`). */
export type MobileAttachmentFileSystemPort = {
  /** The app's document and cache directory URIs, or null when unknown. */
  documentDirectory(): string | null;
  cacheDirectory(): string | null;
  getInfo(uri: string): Promise<MobileAttachmentFileInfo>;
  /** Creates the directory and any missing parents. */
  makeDirectory(uri: string): Promise<void>;
  /** The entry names of a directory. */
  readDirectory(uri: string): Promise<string[]>;
  readBytes(uri: string): Promise<Uint8Array>;
  /** `length` bytes starting at byte `position`. */
  readBytesRange(uri: string, position: number, length: number): Promise<Uint8Array>;
  /** Creates or replaces the file. */
  writeBytes(uri: string, bytes: Uint8Array): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  /** Deletes a file or directory; a missing path is not an error. */
  delete(uri: string): Promise<void>;
  /**
   * Deletes the file unless `keep()` says a record owns it again, asking `keep()` in the same turn as the delete and after
   * every file call made before this one, so no restore can land between the check and the delete. Answers whether it deleted.
   * Absent where a delete starts at once (React Native: expo's delete); then `keep()` runs right before `delete`.
   */
  deleteUnlessKept?(uri: string, keep: () => boolean): Promise<boolean>;
  /** Null when the platform has no Storage Access Framework. Read on every use. */
  saf(): MobileAttachmentSafPort | null;
  /** A file's SHA-256 (hex), streamed by the host so its bytes never cross into memory here. Absent where only bytes can be
   *  hashed (React Native: they go through `setSha256HexProvider`). */
  sha256?(uri: string): Promise<string>;
};

export type AttachmentSyncDir =
  | { type: 'file'; dirUri: string; attachmentsDirUri: string }
  | { type: 'saf'; dirUri: string; attachmentsDirUri: string };

export type AttachmentSafDirectoryEntries =
  | { status: 'available'; entries: Map<string, string> }
  | { status: 'unreadable' };

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

const hasSafLeafName = (value: string, expected: string): boolean => (
  getSafLeafName(value) === expected
);

/** The whole buffer when `bytes` covers it, else a copy (unlike http-utils' `toArrayBuffer`,
 *  which always copies). */
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

/**
 * A local uri whose bytes we may read at all. `migrateAttachmentsLocallyBeforeSync` copies
 * legitimate outside picks (content:// / SAF) into the managed dir, so a uri that fails here
 * must be refused by both the upload gate and that migration — otherwise a traversal uri
 * simply gets copied in and uploaded anyway.
 */
const isTraversalFreeAttachmentUri = (uri: string): boolean =>
  Boolean(sanitizeAttachmentUriForSyncMerge(uri));

/** Core functions called through here so a host's tests can replace them the way they
 *  replace `@mindwtr/core`. A host that passes nothing gets core's own. */
export type MobileAttachmentFilesCoreFunctions = {
  isSandboxMode: typeof isSandboxMode;
};

export type MobileAttachmentFilesHost = {
  fs: MobileAttachmentFileSystemPort;
  /** The device key-value store (React Native: AsyncStorage). */
  storage: SyncKeyValueStoragePort;
  /** Reads a secret sync key from the keystore. */
  getSecureConfigValue(key: string): Promise<string | null>;
  log: Pick<MobileSyncLogPort, 'info' | 'warn' | 'sanitize'>;
  /** The fetch Dropbox token refreshes use when a caller passes none. */
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
    // The id, not the title: mobile's attachment warnings never carry the file name.
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

  const logAttachmentWarn = (
    message: string,
    error?: unknown,
    extra?: Record<string, string>,
  ) => {
    const fields = error
      ? { ...extra, error: host.log.sanitize(error instanceof Error ? error.message : String(error)) }
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
            // Ignore temp cleanup failures.
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
        // Ignore cleanup errors for temp file.
      }
    }
  };

  const copyFileSafely = async (sourceUri: string, targetUri: string): Promise<void> => {
    const tempUri = buildTempUri(targetUri);
    try {
      await fs.copy(sourceUri, tempUri);
    } catch (error) {
      logAttachmentWarn('Attachment temp copy failed, falling back to byte write', error);
      await writeBytesSafely(targetUri, await readFileAsBytes(sourceUri));
      logAttachmentInfo('Attachment byte fallback copied file', { sourceUri, targetUri });
      return;
    }
    try {
      await fs.move(tempUri, targetUri);
    } catch (moveError) {
      logAttachmentWarn('Attachment temp move failed, falling back to direct copy', moveError);
      try {
        await fs.copy(sourceUri, targetUri);
      } catch (copyError) {
        logAttachmentWarn('Attachment direct copy failed, falling back to byte write', copyError);
        await writeBytesSafely(targetUri, await readFileAsBytes(sourceUri));
        logAttachmentInfo('Attachment byte fallback copied file', { sourceUri, targetUri });
      } finally {
        try {
          await fs.delete(tempUri);
        } catch {
          // Ignore cleanup errors for temp file.
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

  /**
   * Removes a local attachment only when its URI proves it is the id-named copy
   * owned by Mindwtr's managed attachments directory. Draft settlement passes
   * candidates here; arbitrary user-picked paths and sibling directories are
   * intentionally rejected. `keep` runs after every await, immediately before the delete:
   * true keeps the file (a live attachment points at it again).
   */
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
        const entries = await saf.readDirectory(candidate);
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
      const entries = await saf.readDirectory(dirUri);
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

  /** Strict SAF inventory used by mutation-capable sync. Missing capability and
   * provider errors are not equivalent to an empty directory. */
  const inspectSafDirectoryEntriesByName = async (
    dirUri: string,
  ): Promise<AttachmentSafDirectoryEntries> => {
    const saf = fs.saf();
    if (!saf) return { status: 'unreadable' };
    try {
      const entries = await saf.readDirectory(dirUri);
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

  // #1057: check-on-touch content-change detection. A `content://` (Android SAF)
  // uri's mtime isn't reliably comparable across accesses, so this returns null for
  // those — the per-sync pre-pass simply skips detection for them, matching the
  // scope note that linked-file detection is desktop-first; SAF-backed files still
  // participate fully on the re-download side via the ordinary cloudKey/hasCloudCopy
  // path, unaffected by this being null.
  const statAttachmentFile = async (uri: string): Promise<LocalFileStat | null> => {
    if (uri.startsWith('content://')) return null;
    try {
      const info = await fs.getInfo(uri);
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

  /**
   * SEC-07: which local uris this device may read bytes from for sync. An attachment `uri`
   * travels inside the synced document and survives the merge sanitizer, so without this a
   * hostile sync document makes the next cycle upload an arbitrary local file to the remote.
   * `migrateAttachmentsLocallyBeforeSync` runs first and copies every legitimate outside
   * file (legacy content:// / SAF references) into the managed dir; whatever is still
   * outside afterwards is refused rather than read.
   */
  const canUploadAttachmentFrom = (uri: string): boolean => {
    const attachmentsDir = getManagedAttachmentsDir();
    if (!attachmentsDir || !uri.startsWith(attachmentsDir)) return false;
    if (!isTraversalFreeAttachmentUri(uri)) return false;
    // The managed layout is flat and id-named (see deleteManagedAttachmentFile), so
    // anything with a further separator is not a file this device owns.
    const leaf = uri.slice(attachmentsDir.length).split(/[?#]/, 1)[0];
    return leaf.length > 0 && !leaf.includes('/');
  };

  /**
   * A uri is task content — the file name is the user's (#854: ids and field names only).
   * Log the scheme, whether the file sits in our own storage, and the extension; those are
   * what every attachment bug so far actually needed, and none of them is user text.
   */
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
        // copyFileSafely streams through the native copy (temp + rename) and
        // only falls back to the JS byte round-trip when the provider refuses
        // the copy — content:// sources included, so share-sheet files avoid a
        // double base64 pass on the JS thread.
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

  // Compatibility shape: callers that only need the (possibly re-homed)
  // attachment. Note the ambiguity — an unchanged result can mean failure OR
  // already-managed; callers that must tell them apart use the Detailed variant.
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
      // If migration failed but the original URI is still readable, the backend can upload from it.
      return { migrated, skipped: false };
    };
  };

  /**
   * Identity of the place attachments live: the backend plus the location/account that
   * decides which remote a `cloudKey` points at. Read from device config rather than passed
   * in, so `hasPendingAttachmentSyncWork` keeps its `(appData, options)` signature and the
   * two gates that consult it (that predicate, and each backend's own presence pass) can
   * never disagree about what "the same backend configuration" means.
   *
   * Shared with sync-encryption discovery scoping (#1138) through `readSyncLocationScope`,
   * so the two features can never disagree about what "the same sync location" means.
   */
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
  const isAttachmentPresenceReconciliationDue = async (): Promise<boolean> => {
    const [scope, stamp] = await Promise.all([
      readAttachmentPresenceScope(),
      readAttachmentPresenceStamp(),
    ]);
    if (scope === null) return true;
    return !isAttachmentPresenceStampFresh(stamp, scope, Date.now());
  };

  /**
   * Records that a full per-attachment pass just ran to completion against the current
   * backend configuration. Called by each backend at the end of its own pass rather than by
   * the predicate above, so a pass that never ran (or aborted) leaves the stamp alone and the
   * next cycle retries instead of parking the reconciliation for a day.
   */
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

  /**
   * The durable "this device has completed at least one full cycle against the active
   * location" fact for backends with no `FastSyncState` record — the file backend above all,
   * since `buildFastSyncScope` returns `null` for it. A presence stamp is only ever written at
   * the END of a completed attachment pass (`markAttachmentPresenceReconciled`), so its
   * existence — for THIS exact scope — proves a full cycle already ran here, which is all the
   * sync-encryption posture gate needs to stop treating a fresh join as "already known safe".
   * Scope-exact on purpose: a stamp from a previous location must not vouch for a new one.
   *
   * Takes NO scope argument on purpose: it derives the comparison scope the exact same way
   * `markAttachmentPresenceReconciled` writes it. A caller once passed the sync service's
   * scope, built from the RESOLVED file path, and the stamp compared unequal forever (review
   * finding B2); deriving the scope in the one place that also writes it makes the two sides
   * symmetric by construction.
   */
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
      //    (sync.ts) lands an incoming content winner with NO recorded
      //    contentMtimeMs/contentSize, precisely so the receiving device re-checks and
      //    re-downloads. An absent recorded stat is therefore the download signal, and
      //    it is already in the document — no local stat, no request, no file bytes read.
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

    if (shouldCheckManagedStorage) {
      for (const attachment of attachmentsById.values()) {
        if (attachmentNeedsManagedLocalCopy(attachment)) {
          return true;
        }
      }
    }

    // Nothing in the document says there is work to do. The one remaining reason to run the
    // phase is the periodic presence proof — and only when there is something to prove, so a
    // library with no settled attachments never reads device config at all.
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
