// The mobile attachment cleanup run: core's cleanup lifecycle (`runAttachmentCleanupLifecycle`)
// wired to the mobile backends' remote deletes and the device's managed attachment files. It
// moved here from React Native's `apps/mobile/lib/sync-attachment-cleanup.ts` so the native apps
// clean up the same way.
//
// Data safety: `attachments.pendingRemoteDeletes` is kept and retried by the lifecycle; a local
// file is deleted only inside the managed attachments directories; a WebDAV delete is versioned
// (no strong ETag, no delete); File Sync keeps remote bytes, because another peer may reselect a
// generation before its document CAS.
import type { AppData, Attachment } from './types';
import { ATTACHMENTS_DIR_NAME, getBaseSyncUrl, getCloudBaseUrl } from './attachment-paths';
import { runAttachmentCleanupLifecycle } from './attachment-cleanup';
import { NativeAttachmentCleanupUnconfirmedError } from './native-attachment-cleanup';
import { decodeUriSafe } from './async-utils';
import { cloudDeleteFile } from './cloud';
import { DropboxConflictError } from './dropbox';
import { isSyncRemoteMutationFenceError } from './sync-remote-fence';
import { getErrorStatus } from './sync-runtime-utils';
import { sanitizeAttachmentUriForSyncMerge } from './sync-normalization';
import { isWebdavRemoteWriteConflictError, normalizeStrongWebdavEtag, webdavDeleteFileVersioned, webdavHeadFile } from './webdav';
import { getMobileCloudRequestOptions, getMobileWebDavRequestOptions } from './mobile-sync-utils';
import type { MobileAttachmentFileSystemPort } from './mobile-attachment-files';
import type { MobileSyncAttachmentCleanupOptions } from './mobile-sync-service';

const ATTACHMENT_CLEANUP_BATCH_LIMIT = 25;

/** Core functions called through here so a host's tests can replace them the way they
 *  replace `@mindwtr/core`. A host that passes nothing gets core's own. */
export type MobileAttachmentCleanupCoreFunctions = {
  getBaseSyncUrl: typeof getBaseSyncUrl;
  getCloudBaseUrl: typeof getCloudBaseUrl;
  webdavHeadFile: typeof webdavHeadFile;
  webdavDeleteFileVersioned: typeof webdavDeleteFileVersioned;
  cloudDeleteFile: typeof cloudDeleteFile;
};

export type MobileAttachmentCleanupHost = {
  fs: Pick<MobileAttachmentFileSystemPort, 'documentDirectory' | 'cacheDirectory' | 'delete' | 'deleteUnlessKept'>;
  retireLocalAttachment?(attachmentID: string, targetURI: string, keep: () => boolean): Promise<boolean>;
  /** A Dropbox write conflict must end the cycle instead of being logged and skipped. */
  isDropboxConflictError?(error: unknown): boolean;
  core?: Partial<MobileAttachmentCleanupCoreFunctions>;
};

export type MobileAttachmentCleanupResult = {
  appData: AppData;
  shouldInvalidateFastSyncState: boolean;
};

export const runMobileAttachmentCleanup = async (
  options: MobileSyncAttachmentCleanupOptions,
  host: MobileAttachmentCleanupHost,
): Promise<MobileAttachmentCleanupResult> => {
  const core: MobileAttachmentCleanupCoreFunctions = {
    getBaseSyncUrl,
    getCloudBaseUrl,
    webdavHeadFile,
    webdavDeleteFileVersioned,
    cloudDeleteFile,
    ...host.core,
  };
  const isDropboxConflictError = host.isDropboxConflictError
    ?? ((error: unknown) => error instanceof DropboxConflictError);

  const getManagedAttachmentCleanupPrefixes = (): string[] => {
    return [host.fs.documentDirectory(), host.fs.cacheDirectory()]
      .filter((base): base is string => typeof base === 'string' && base.length > 0)
      .map((base) => {
        const normalized = base.endsWith('/') ? base : `${base}/`;
        return `${normalized}${ATTACHMENTS_DIR_NAME}/`;
      });
  };

  const deleteAttachmentFile = async (attachment: Attachment): Promise<void> => {
    const safeUri = sanitizeAttachmentUriForSyncMerge(attachment.uri);
    if (!safeUri) return;
    if (safeUri.startsWith('content://') || /^https?:\/\//i.test(safeUri)) return;
    const decodedUri = decodeUriSafe(safeUri);
    const managedPrefixes = getManagedAttachmentCleanupPrefixes();
    if (!managedPrefixes.some((prefix) => safeUri.startsWith(prefix) || decodedUri.startsWith(prefix))) {
      return;
    }
    try {
      options.ensureLocalSnapshotFresh();
      if (host.retireLocalAttachment || host.fs.deleteUnlessKept) {
        const keep = () => {
          // The lifecycle checked live references; freshness binds that same snapshot.
          options.ensureLocalSnapshotFresh();
          return false;
        };
        const removed = host.retireLocalAttachment
          ? await host.retireLocalAttachment(attachment.id, safeUri, keep)
          : await host.fs.deleteUnlessKept!(safeUri, keep);
        try {
          options.logSyncInfo('Attachment cleanup freshness guarded', {
            releaseCheck: 'v1.3.5/native-cleanup-freshness',
            outcome: removed ? 'removed' : 'retained',
          });
        } catch {
          // Logging must not change the acknowledged file operation.
        }
      } else {
        await host.fs.delete(safeUri);
      }
    } catch (error) {
      if (error instanceof NativeAttachmentCleanupUnconfirmedError) throw error;
      if (error instanceof Error && error.name === 'LocalSyncAbort') throw error;
      options.logSyncWarning('Failed to delete attachment file', error);
    }
  };

  const isWebdavBackend = options.backend === 'webdav' && Boolean(options.webdavConfig?.url);
  const isCloudBackend = options.backend === 'cloud'
    && options.cloudProvider === 'selfhosted'
    && Boolean(options.cloudConfig?.url);
  const isDropboxBackend = options.backend === 'cloud' && options.cloudProvider === 'dropbox';
  const canAttemptRemoteDelete = Boolean(
    isWebdavBackend
    || isCloudBackend
    || isDropboxBackend
  );
  const deleteRemoteAttachment = canAttemptRemoteDelete
    ? async (target: { cloudKey: string }) => {
      if (isWebdavBackend && options.webdavConfig) {
        const baseSyncUrl = core.getBaseSyncUrl(options.webdavConfig.url);
        const targetUrl = baseSyncUrl + '/' + target.cloudKey;
        const metadata = await core.webdavHeadFile(targetUrl, {
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
        await core.webdavDeleteFileVersioned(targetUrl, etag, {
          ...getMobileWebDavRequestOptions(options.webdavConfig.allowInsecureHttp),
          username: options.webdavConfig.username,
          password: options.webdavConfig.password,
          timeoutMs: 30_000,
          fetcher: options.fetcher,
        });
      } else if (isCloudBackend && options.cloudConfig) {
        const baseSyncUrl = core.getCloudBaseUrl(options.cloudConfig.url);
        options.ensureLocalSnapshotFresh();
        await core.cloudDeleteFile(baseSyncUrl + '/' + target.cloudKey, {
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
      }
    }
    : undefined;

  const result = await runAttachmentCleanupLifecycle({
    appData: options.appData,
    maxAttachmentTargets: ATTACHMENT_CLEANUP_BATCH_LIMIT,
    beforeEachAttachment: options.ensureLocalSnapshotFresh,
    beforeEachRemoteDelete: options.ensureLocalSnapshotFresh,
    deleteLocalAttachment: deleteAttachmentFile,
    deleteRemoteAttachment,
    // File Sync folders are replicated independently. Without a distributed
    // GC tombstone, another peer can reselect any existing generation before
    // its document CAS, so cleanup removes metadata only and retains bytes.
    shouldRetainRemoteAttachment: options.backend === 'file' ? () => true : undefined,
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
        || isDropboxConflictError(error)
      ) throw error;
      options.logSyncWarning('Failed to delete remote attachment', error);
    },
    onBatchLimitReached: ({ limit, total, fresh }) => {
      options.logSyncInfo('Attachment cleanup batch limit reached', {
        releaseCheck: 'v1.3.5/cleanup-batch-fresh-first',
        limit: String(limit),
        total: String(total),
        fresh: String(fresh),
      });
    },
  });
  return {
    appData: result.appData,
    shouldInvalidateFastSyncState: result.shouldInvalidateFastSyncState,
  };
};
