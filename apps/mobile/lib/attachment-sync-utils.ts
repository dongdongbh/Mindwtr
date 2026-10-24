import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import * as FileSystem from './file-system';
import { listSafChildren, statSafDocument, writeSafDocument } from './saf-documents';
import {
  ATTACHMENTS_DIR_NAME,
  ATTACHMENT_PRESENCE_RECONCILE_INTERVAL_MS,
  base64ToBytes,
  buildCloudKey,
  bytesToBase64,
  collectAttachmentsById,
  extractExtension,
  getBaseSyncUrl,
  getCloudBaseUrl,
  isSandboxMode,
  markAttachmentUnrecoverable,
  reportProgress,
  sleep,
  validateAttachmentHash,
} from '@mindwtr/core';
import {
  ATTACHMENT_LOCAL_MIGRATION_MAX_PER_SYNC,
  createMobileAttachmentFiles,
  DEFAULT_ATTACHMENT_CONTENT_TYPE,
  DROPBOX_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC,
  DROPBOX_ATTACHMENT_MAX_UPLOADS_PER_SYNC,
  FILE_BACKEND_VALIDATION_CONFIG,
  getAttachmentLocalStatus,
  getSafLeafName,
  isContentAttachmentUri,
  isHttpAttachmentUri,
  toAttachmentArrayBuffer,
  WEBDAV_ATTACHMENT_COOLDOWN_MS,
  WEBDAV_ATTACHMENT_ERROR_BACKOFF_MS,
  WEBDAV_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC,
  WEBDAV_ATTACHMENT_MAX_UPLOADS_PER_SYNC,
  WEBDAV_ATTACHMENT_MIN_INTERVAL_MS,
  WEBDAV_ATTACHMENT_MISSING_BACKOFF_MS,
  WEBDAV_ATTACHMENT_RETRY_OPTIONS,
  type AttachmentSafDirectoryEntries,
  type AttachmentSyncDir,
  type MobileAttachmentFiles,
  type MobileAttachmentFileSystemPort,
} from '@mindwtr/core/mobile-attachment-files';
import { readDropboxAppKey, type MobileWebDavStoredConfig } from '@mindwtr/core/mobile-sync-utils';
import type { MobileCloudSyncConfig } from '@mindwtr/core/mobile-sync-service';
import { getSecureConfigValue } from './secure-config';
import { logInfo, logWarn, sanitizeLogMessage } from './app-log';
import { backgroundSafeFetch } from './background-safe-fetch';

// The attachment files layer — managed storage, safe writes, presence and stat, the refusal
// budget, the download backoff, the stored configs, the presence stamp and the pending-work
// predicate — lives in core (`packages/core/src/mobile-attachment-files.ts`) so the native app
// runs the same rules. This module binds it to expo-file-system, AsyncStorage, the keystore,
// the Dropbox credentials and the app log. Every binding calls the imported function when
// used, so tests that replace these modules still reach their mocks; the core object is made
// on first use.

export {
  ATTACHMENT_LOCAL_MIGRATION_MAX_PER_SYNC,
  ATTACHMENT_PRESENCE_RECONCILE_INTERVAL_MS,
  ATTACHMENTS_DIR_NAME,
  base64ToBytes,
  buildCloudKey,
  bytesToBase64,
  DROPBOX_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC,
  DROPBOX_ATTACHMENT_MAX_UPLOADS_PER_SYNC,
  extractExtension,
  FILE_BACKEND_VALIDATION_CONFIG,
  getAttachmentLocalStatus,
  getBaseSyncUrl,
  getCloudBaseUrl,
  getSafLeafName,
  isContentAttachmentUri,
  isHttpAttachmentUri,
  reportProgress,
  validateAttachmentHash,
  WEBDAV_ATTACHMENT_COOLDOWN_MS,
  WEBDAV_ATTACHMENT_ERROR_BACKOFF_MS,
  WEBDAV_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC,
  WEBDAV_ATTACHMENT_MAX_UPLOADS_PER_SYNC,
  WEBDAV_ATTACHMENT_MIN_INTERVAL_MS,
  WEBDAV_ATTACHMENT_MISSING_BACKOFF_MS,
  WEBDAV_ATTACHMENT_RETRY_OPTIONS,
};
export type { DropboxAccessTokenResolver, PersistAttachmentOutcome } from '@mindwtr/core/mobile-attachment-files';
// `collectAttachments` predates `collectAttachmentsById` moving into core (packages/core/src/
// attachment-transfer.ts) — kept under its original name here so none of the 5 backend files
// need a call-site rename.
export const collectAttachments = collectAttachmentsById;
export const DEFAULT_CONTENT_TYPE = DEFAULT_ATTACHMENT_CONTENT_TYPE;
export const StorageAccessFramework = FileSystem.StorageAccessFramework;
export const toArrayBuffer = toAttachmentArrayBuffer;
export const CLOUD_PROVIDER_DROPBOX = 'dropbox';

export { markAttachmentUnrecoverable, sleep };

export type WebDavConfig = MobileWebDavStoredConfig;
export type CloudConfig = MobileCloudSyncConfig;
export type ResolvedSyncDir = AttachmentSyncDir;
export type SafDirectoryEntriesResult = AttachmentSafDirectoryEntries;

/** expo-file-system as core's attachment file port. Shared with the attachment passes and the
 *  cleanup run. */
export const mobileAttachmentFileSystem: MobileAttachmentFileSystemPort = {
  documentDirectory: () => FileSystem.documentDirectory,
  cacheDirectory: () => FileSystem.cacheDirectory,
  getInfo: (uri) => FileSystem.getInfoAsync(uri),
  makeDirectory: (uri) => FileSystem.makeDirectoryAsync(uri, { intermediates: true }),
  readDirectory: (uri) => FileSystem.readDirectoryAsync(uri),
  readBytes: async (uri) => base64ToBytes(
    await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 }),
  ),
  // The legacy module, not the wrapper: the modern File API cannot read a byte range.
  readBytesRange: async (uri, position, length) => base64ToBytes(
    await LegacyFileSystem.readAsStringAsync(uri, {
      encoding: LegacyFileSystem.EncodingType.Base64,
      position,
      length,
    }),
  ),
  writeBytes: (uri, bytes) => FileSystem.writeAsStringAsync(
    uri,
    bytesToBase64(bytes),
    { encoding: FileSystem.EncodingType.Base64 },
  ),
  copy: (from, to) => FileSystem.copyAsync({ from, to }),
  move: (from, to) => FileSystem.moveAsync({ from, to }),
  delete: (uri) => FileSystem.deleteAsync(uri, { idempotent: true }),
  saf: () => {
    const saf = FileSystem.StorageAccessFramework;
    if (!saf?.readDirectoryAsync) return null;
    return {
      readDirectory: (uri) => saf.readDirectoryAsync(uri),
      // SafDocumentsCore's listing and lookup: display names (document IDs are opaque) and
      // provider errors that reject instead of reading as an empty folder.
      listChildren: (uri) => listSafChildren(uri),
      stat: (uri) => statSafDocument(uri),
      makeDirectory: (parentUri, name) => saf.makeDirectoryAsync(parentUri, name),
      createFile: (parentUri, name, mimeType) => saf.createFileAsync(parentUri, name, mimeType),
      // No writability pre-check (SafDocumentsCore.writeBytes): expo's legacy SAF write refuses
      // every attempt on RSAF, which never declares FLAG_SUPPORTS_WRITE (#1001).
      writeBytes: (uri, bytes) => writeSafDocument(uri, bytes),
    };
  },
};

let files: MobileAttachmentFiles | null = null;

/** The core attachment files object, made on first use. */
export const mobileAttachmentFiles = (): MobileAttachmentFiles => {
  if (files) return files;
  files = createMobileAttachmentFiles({
    fs: mobileAttachmentFileSystem,
    storage: {
      getItem: (key) => AsyncStorage.getItem(key),
      setItem: (key, value) => AsyncStorage.setItem(key, value),
      removeItem: (key) => AsyncStorage.removeItem(key),
    },
    getSecureConfigValue: (key) => getSecureConfigValue(key),
    log: {
      info: (message, context) => logInfo(message, context),
      warn: (message, context) => logWarn(message, context),
      sanitize: (message) => sanitizeLogMessage(message),
    },
    fetch: backgroundSafeFetch,
    dropboxAuth: {
      getValidAccessToken: async (clientId, fetcher) => (
        (await import('./dropbox-auth')).getValidDropboxAccessToken(clientId, fetcher)
      ),
      forceRefreshAccessToken: async (clientId, fetcher) => (
        (await import('./dropbox-auth')).forceRefreshDropboxAccessToken(clientId, fetcher)
      ),
    },
    core: {
      isSandboxMode: () => isSandboxMode(),
    },
  });
  return files;
};

type Files = MobileAttachmentFiles;

export const clearAttachmentUploadRefusal: Files['clearAttachmentUploadRefusal'] = (...args) => (
  mobileAttachmentFiles().clearAttachmentUploadRefusal(...args)
);
export const clearAttachmentUploadRefusals: Files['clearAttachmentUploadRefusals'] = () => (
  mobileAttachmentFiles().clearAttachmentUploadRefusals()
);
export const clearWebdavDownloadBackoffs: Files['clearWebdavDownloadBackoffs'] = () => (
  mobileAttachmentFiles().clearWebdavDownloadBackoffs()
);
export const shouldAttemptAttachmentUpload: Files['shouldAttemptAttachmentUpload'] = (...args) => (
  mobileAttachmentFiles().shouldAttemptAttachmentUpload(...args)
);
export const handleAttachmentUploadRefusal: Files['handleAttachmentUploadRefusal'] = (...args) => (
  mobileAttachmentFiles().handleAttachmentUploadRefusal(...args)
);
export const logAttachmentWarn: Files['logAttachmentWarn'] = (...args) => (
  mobileAttachmentFiles().logAttachmentWarn(...args)
);
export const logAttachmentInfo: Files['logAttachmentInfo'] = (...args) => (
  mobileAttachmentFiles().logAttachmentInfo(...args)
);
export const getWebdavDownloadBackoff: Files['getWebdavDownloadBackoff'] = (...args) => (
  mobileAttachmentFiles().getWebdavDownloadBackoff(...args)
);
export const setWebdavDownloadBackoff: Files['setWebdavDownloadBackoff'] = (...args) => (
  mobileAttachmentFiles().setWebdavDownloadBackoff(...args)
);
export const clearWebdavDownloadBackoff: Files['clearWebdavDownloadBackoff'] = (...args) => (
  mobileAttachmentFiles().clearWebdavDownloadBackoff(...args)
);
export const pruneWebdavDownloadBackoff: Files['pruneWebdavDownloadBackoff'] = () => (
  mobileAttachmentFiles().pruneWebdavDownloadBackoff()
);
export const readAttachmentBytesForUpload: Files['readAttachmentBytesForUpload'] = (...args) => (
  mobileAttachmentFiles().readAttachmentBytesForUpload(...args)
);
export const writeBytesSafely: Files['writeBytesSafely'] = (...args) => (
  mobileAttachmentFiles().writeBytesSafely(...args)
);
export const copyFileSafely: Files['copyFileSafely'] = (...args) => (
  mobileAttachmentFiles().copyFileSafely(...args)
);

export const getDropboxClientId = async (): Promise<string> => {
  try {
    const constantsModule = await import('expo-constants');
    const constants = constantsModule.default as { expoConfig?: { extra?: unknown } } | undefined;
    return readDropboxAppKey(constants?.expoConfig?.extra);
  } catch {
    return '';
  }
};

export const runDropboxAuthorized: Files['runDropboxAuthorized'] = (...args) => (
  mobileAttachmentFiles().runDropboxAuthorized(...args)
);
export const loadWebDavConfig: Files['loadWebDavConfig'] = () => mobileAttachmentFiles().loadWebDavConfig();
export const loadCloudConfig: Files['loadCloudConfig'] = () => mobileAttachmentFiles().loadCloudConfig();
export const getAttachmentsDir: Files['getAttachmentsDir'] = () => mobileAttachmentFiles().getAttachmentsDir();
export const deleteManagedAttachmentFile: Files['deleteManagedAttachmentFile'] = (...args) => (
  mobileAttachmentFiles().deleteManagedAttachmentFile(...args)
);
export const cleanupAttachmentTempFiles: Files['cleanupAttachmentTempFiles'] = () => (
  mobileAttachmentFiles().cleanupAttachmentTempFiles()
);
export const resolveFileSyncDir: Files['resolveFileSyncDir'] = (...args) => (
  mobileAttachmentFiles().resolveFileSyncDir(...args)
);
export const readSafDirectoryEntriesByName: Files['readSafDirectoryEntriesByName'] = (...args) => (
  mobileAttachmentFiles().readSafDirectoryEntriesByName(...args)
);
export const inspectSafDirectoryEntriesByName: Files['inspectSafDirectoryEntriesByName'] = (...args) => (
  mobileAttachmentFiles().inspectSafDirectoryEntriesByName(...args)
);
export const findSafEntry: Files['findSafEntry'] = (...args) => mobileAttachmentFiles().findSafEntry(...args);
export const readFileAsBytes: Files['readFileAsBytes'] = (...args) => mobileAttachmentFiles().readFileAsBytes(...args);
export const getAttachmentByteSize: Files['getAttachmentByteSize'] = (...args) => (
  mobileAttachmentFiles().getAttachmentByteSize(...args)
);
export const getLocalAttachmentPresence: Files['getLocalAttachmentPresence'] = (...args) => (
  mobileAttachmentFiles().getLocalAttachmentPresence(...args)
);
export const statAttachmentFile: Files['statAttachmentFile'] = (...args) => (
  mobileAttachmentFiles().statAttachmentFile(...args)
);
export const computeAttachmentFileHash: Files['computeAttachmentFileHash'] = (...args) => (
  mobileAttachmentFiles().computeAttachmentFileHash(...args)
);
export const persistAttachmentLocallyDetailed: Files['persistAttachmentLocallyDetailed'] = (...args) => (
  mobileAttachmentFiles().persistAttachmentLocallyDetailed(...args)
);
export const persistAttachmentLocally: Files['persistAttachmentLocally'] = (...args) => (
  mobileAttachmentFiles().persistAttachmentLocally(...args)
);
export const ensureAttachmentStoredLocally: Files['ensureAttachmentStoredLocally'] = (...args) => (
  mobileAttachmentFiles().ensureAttachmentStoredLocally(...args)
);
export const canUploadAttachmentFrom: Files['canUploadAttachmentFrom'] = (...args) => (
  mobileAttachmentFiles().canUploadAttachmentFrom(...args)
);
export const describeAttachmentUriForLog: Files['describeAttachmentUriForLog'] = (...args) => (
  mobileAttachmentFiles().describeAttachmentUriForLog(...args)
);
export const attachmentNeedsManagedLocalCopy: Files['attachmentNeedsManagedLocalCopy'] = (...args) => (
  mobileAttachmentFiles().attachmentNeedsManagedLocalCopy(...args)
);
export const createAttachmentLocalMigrationLimiter: Files['createAttachmentLocalMigrationLimiter'] = (...args) => (
  mobileAttachmentFiles().createAttachmentLocalMigrationLimiter(...args)
);
export const isAttachmentPresenceReconciliationDue: Files['isAttachmentPresenceReconciliationDue'] = () => (
  mobileAttachmentFiles().isAttachmentPresenceReconciliationDue()
);
export const markAttachmentPresenceReconciled: Files['markAttachmentPresenceReconciled'] = () => (
  mobileAttachmentFiles().markAttachmentPresenceReconciled()
);
export const hasCompletedAttachmentPresenceReconciliation: Files['hasCompletedAttachmentPresenceReconciliation'] = () => (
  mobileAttachmentFiles().hasCompletedAttachmentPresenceReconciliation()
);
export const hasPendingAttachmentSyncWork: Files['hasPendingAttachmentSyncWork'] = (...args) => (
  mobileAttachmentFiles().hasPendingAttachmentSyncWork(...args)
);
