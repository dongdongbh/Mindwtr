import {
  AppData,
  cloudDeleteFile,
  decodeUriSafe,
  getErrorStatus,
  isFileSyncGenerationCloudKey,
  isSyncRemoteMutationFenceError,
  isWebdavRemoteWriteConflictError,
  normalizeStrongWebdavEtag,
  runAttachmentCleanupLifecycle,
  sanitizeAttachmentCloudKeyForSyncMerge,
  sanitizeAttachmentUriForSyncMerge,
  webdavDeleteFileVersioned,
  webdavHeadFile,
  type CloudProvider,
} from '@mindwtr/core';
import { getBaseSyncUrl, getCloudBaseUrl } from './attachment-sync';
import {
  ATTACHMENTS_DIR_NAME,
  inspectSafDirectoryEntriesByName,
  resolveFileSyncDir,
} from './attachment-sync-utils';
import * as FileSystem from './file-system';
import { getFileSyncBaseDir, type SyncBackend } from './sync-service-utils';
import { getMobileCloudRequestOptions, getMobileWebDavRequestOptions } from './webdav-request-options';
import { DropboxConflictError } from './dropbox-sync';

const ATTACHMENT_CLEANUP_BATCH_LIMIT = 25;

type MobileWebDavCleanupConfig = {
  url: string;
  username: string;
  password: string;
  allowInsecureHttp?: boolean;
};

type MobileCloudCleanupConfig = {
  url: string;
  token: string;
  allowInsecureHttp?: boolean;
};

type MobileAttachmentCleanupOptions = {
  appData: AppData;
  backend: SyncBackend;
  webdavConfig: MobileWebDavCleanupConfig | null;
  cloudConfig: MobileCloudCleanupConfig | null;
  cloudProvider: CloudProvider;
  fileSyncPath: string | null;
  fetcher: typeof fetch;
  ensureLocalSnapshotFresh: () => void;
  assertRemoteMutationFenceHeld?: (minRemainingMs?: number) => Promise<void>;
  deleteDropboxAttachment: (
    cloudKey: string,
    ensureBeforeProviderDelete: () => void
  ) => Promise<void>;
  isRemoteMissingError: (error: unknown) => boolean;
  logSyncInfo: (message: string, extra?: Record<string, string>) => void;
  logSyncWarning: (message: string, error?: unknown) => void;
};

type MobileAttachmentCleanupResult = {
  appData: AppData;
  shouldInvalidateFastSyncState: boolean;
};

const getManagedAttachmentCleanupPrefixes = (): string[] => {
  return [FileSystem.documentDirectory, FileSystem.cacheDirectory]
    .filter((base): base is string => typeof base === 'string' && base.length > 0)
    .map((base) => {
      const normalized = base.endsWith('/') ? base : `${base}/`;
      return `${normalized}${ATTACHMENTS_DIR_NAME}/`;
    });
};

const deleteAttachmentFile = async (
  uri: string | undefined,
  logSyncWarning: MobileAttachmentCleanupOptions['logSyncWarning'],
  ensureLocalSnapshotFresh: MobileAttachmentCleanupOptions['ensureLocalSnapshotFresh']
): Promise<void> => {
  const safeUri = sanitizeAttachmentUriForSyncMerge(uri);
  if (!safeUri) return;
  if (safeUri.startsWith('content://') || /^https?:\/\//i.test(safeUri)) return;
  const decodedUri = decodeUriSafe(safeUri);
  const managedPrefixes = getManagedAttachmentCleanupPrefixes();
  if (!managedPrefixes.some((prefix) => safeUri.startsWith(prefix) || decodedUri.startsWith(prefix))) {
    return;
  }
  try {
    ensureLocalSnapshotFresh();
    await FileSystem.deleteAsync(safeUri, { idempotent: true });
  } catch (error) {
    if (error instanceof Error && error.name === 'LocalSyncAbort') throw error;
    logSyncWarning('Failed to delete attachment file', error);
  }
};

export const runMobileAttachmentCleanup = async (
  options: MobileAttachmentCleanupOptions
): Promise<MobileAttachmentCleanupResult> => {
  const isWebdavBackend = options.backend === 'webdav' && Boolean(options.webdavConfig?.url);
  const isCloudBackend = options.backend === 'cloud'
    && options.cloudProvider === 'selfhosted'
    && Boolean(options.cloudConfig?.url);
  const isDropboxBackend = options.backend === 'cloud' && options.cloudProvider === 'dropbox';
  const isSafFileBackend = options.backend === 'file'
    && Boolean(options.fileSyncPath?.startsWith('content://'));
  const fileBaseDir = options.backend === 'file'
    && options.fileSyncPath
    && !options.fileSyncPath.startsWith('content://')
    ? getFileSyncBaseDir(options.fileSyncPath)
    : null;
  const canAttemptRemoteDelete = Boolean(
    isWebdavBackend
    || isCloudBackend
    || isDropboxBackend
    || isSafFileBackend
    || fileBaseDir
  );
  const deleteRemoteAttachment = canAttemptRemoteDelete
    ? async (target: { cloudKey: string }) => {
      if (isWebdavBackend && options.webdavConfig) {
        const baseSyncUrl = getBaseSyncUrl(options.webdavConfig.url);
        const targetUrl = baseSyncUrl + '/' + target.cloudKey;
        const metadata = await webdavHeadFile(targetUrl, {
          ...getMobileWebDavRequestOptions(options.webdavConfig.allowInsecureHttp),
          username: options.webdavConfig.username,
          password: options.webdavConfig.password,
          timeoutMs: 30_000,
          fetcher: options.fetcher,
        });
        if (!metadata.exists) {
          const missing = new Error('WebDAV attachment is already missing');
          (missing as Error & { status?: number }).status = 404;
          throw missing;
        }
        const etag = normalizeStrongWebdavEtag(metadata.etag);
        if (!etag) throw new Error('WebDAV attachment version is unavailable; refusing an unconditional delete');
        options.ensureLocalSnapshotFresh();
        await options.assertRemoteMutationFenceHeld?.(35_000);
        await webdavDeleteFileVersioned(targetUrl, etag, {
          ...getMobileWebDavRequestOptions(options.webdavConfig.allowInsecureHttp),
          username: options.webdavConfig.username,
          password: options.webdavConfig.password,
          timeoutMs: 30_000,
          fetcher: options.fetcher,
        });
      } else if (isCloudBackend && options.cloudConfig) {
        const baseSyncUrl = getCloudBaseUrl(options.cloudConfig.url);
        options.ensureLocalSnapshotFresh();
        await cloudDeleteFile(baseSyncUrl + '/' + target.cloudKey, {
          ...getMobileCloudRequestOptions(options.cloudConfig.allowInsecureHttp),
          token: options.cloudConfig.token,
          timeoutMs: 30_000,
          fetcher: options.fetcher,
        });
      } else if (isDropboxBackend) {
        options.ensureLocalSnapshotFresh();
        await options.deleteDropboxAttachment(
          target.cloudKey,
          options.ensureLocalSnapshotFresh,
        );
      } else if (fileBaseDir) {
        options.ensureLocalSnapshotFresh();
        await FileSystem.deleteAsync(fileBaseDir + '/' + target.cloudKey, { idempotent: true });
      } else if (isSafFileBackend && options.fileSyncPath) {
        const cloudKey = sanitizeAttachmentCloudKeyForSyncMerge(target.cloudKey);
        if (cloudKey !== target.cloudKey || !isFileSyncGenerationCloudKey(cloudKey)) {
          throw new Error('SAF File Sync cleanup requires an exact generation key');
        }
        const fileName = cloudKey.slice(`${ATTACHMENTS_DIR_NAME}/`.length);

        options.ensureLocalSnapshotFresh();
        const syncDir = await resolveFileSyncDir(options.fileSyncPath);
        if (!syncDir || syncDir.type !== 'saf') {
          throw new Error('SAF File Sync attachments directory is unavailable');
        }
        const inventory = await inspectSafDirectoryEntriesByName(syncDir.attachmentsDirUri);
        if (inventory.status !== 'available') {
          throw new Error('SAF File Sync attachments directory is unreadable');
        }
        const targetUri = inventory.entries.get(fileName);
        if (!targetUri) return;

        options.ensureLocalSnapshotFresh();
        await FileSystem.deleteAsync(targetUri, { idempotent: true });
      }
    }
    : undefined;

  const result = await runAttachmentCleanupLifecycle({
    appData: options.appData,
    maxAttachmentTargets: ATTACHMENT_CLEANUP_BATCH_LIMIT,
    beforeEachAttachment: options.ensureLocalSnapshotFresh,
    beforeEachRemoteDelete: options.ensureLocalSnapshotFresh,
    deleteLocalAttachment: (attachment) => deleteAttachmentFile(
      attachment.uri,
      options.logSyncWarning,
      options.ensureLocalSnapshotFresh,
    ),
    deleteRemoteAttachment,
    isRemoteMissingError: (error) => options.isRemoteMissingError(error) || getErrorStatus(error) === 404,
    onRemoteAttachmentMissing: (target) => {
      options.logSyncInfo('Remote attachment already missing during cleanup', {
        cloudKey: target.cloudKey,
      });
    },
    onRemoteDeleteError: (_target, error) => {
      if (
        isSyncRemoteMutationFenceError(error)
        || isWebdavRemoteWriteConflictError(error)
        || error instanceof DropboxConflictError
      ) throw error;
      options.logSyncWarning('Failed to delete remote attachment', error);
    },
    onBatchLimitReached: ({ limit, total }) => {
      options.logSyncInfo('Attachment cleanup batch limit reached', {
        limit: String(limit),
        total: String(total),
      });
    },
  });
  return {
    appData: result.appData,
    shouldInvalidateFastSyncState: result.shouldInvalidateFastSyncState,
  };
};
