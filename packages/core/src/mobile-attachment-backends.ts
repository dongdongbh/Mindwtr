


import type { AppData, Attachment } from './types';
import { applyAttachmentContentStat, type LocalFileStat } from './attachment-change-detection';
import { computeSha256Hex, isSha256Hex } from './attachment-hash';
import { ATTACHMENTS_DIR_NAME, buildCloudKey, buildFileSyncGenerationCloudKey, extractExtension } from './attachment-paths';
import { isAttachmentPresenceRepairCandidate, repairMissingRemoteAttachments } from './attachment-presence-repair';
import {
  applyAttachmentPatches,
  collectAttachmentsById,
  CloudHostUploadLimitError,
  assertBufferedAttachmentUploadSize,
  isAttachmentUploadAdmissionError,
  MAX_FILE_SYNC_BUFFERED_PLAINTEXT_BYTES,
  reportProgress,
  validateAttachmentHash,
  WebdavHostUploadLimitError,
  type AttachmentDownloadExpectation,
  type AttachmentTransferAdmission,
} from './attachment-transfer';
import { handleRemoteAttachmentNotFound, markAttachmentUnrecoverable, validateAttachmentForUpload } from './attachment-validation';
import { cloudAttachmentExists, cloudGetFile, cloudPutFile, isBlockedAttachmentContentRefusal } from './cloud';
import {
  createDropboxAttachmentPresenceIndex,
  DROPBOX_ATTACHMENTS_PATH,
  DropboxConflictError,
  DropboxFileNotFoundError,
  downloadDropboxFile,
  getDropboxFileMetadata,
  listDropboxFolderFiles,
  uploadDropboxFileVersioned,
} from './dropbox';
import { isAbortError, isHostResponseTooLargeError, refuseWriteRedirect } from './http-utils';
import { withRetry } from './retry-utils';
import { encryptedSyncArtifactByteLength, inspectSyncArtifact, type SyncKeyMaterial } from './sync-crypto';
import { isSyncRemoteMutationFenceError } from './sync-remote-fence';
import { compareSyncTransitionEntryNames, isSyncEncryptionPartlyEncryptedError, SyncEncryptionPartlyEncryptedError } from './sync-encryption';
import { getErrorStatus, isWebdavRateLimitedError } from './sync-runtime-utils';
import {
  isWebdavRemoteWriteConflictError,
  normalizeStrongWebdavEtag,
  webdavConfirmUploadedFile,
  webdavFileExists,
  webdavGetFile,
  webdavHeadFile,
  webdavMakeDirectory,
  webdavPutFileVersioned,
} from './webdav';
import {
  assertMobileWebdavConnection,
  getMobileCloudRequestOptions,
  getMobileWebDavRequestOptions,
  type MobileWebDavStoredConfig,
} from './mobile-sync-utils';
import {
  DEFAULT_ATTACHMENT_CONTENT_TYPE,
  DROPBOX_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC,
  DROPBOX_ATTACHMENT_MAX_UPLOADS_PER_SYNC,
  FILE_BACKEND_VALIDATION_CONFIG,
  getAttachmentLocalStatus,
  getSafDocumentName,
  isContentAttachmentUri,
  isHttpAttachmentUri,
  toAttachmentArrayBuffer,
  WEBDAV_ATTACHMENT_COOLDOWN_MS,
  WEBDAV_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC,
  WEBDAV_ATTACHMENT_MAX_UPLOADS_PER_SYNC,
  WEBDAV_ATTACHMENT_MIN_INTERVAL_MS,
  WEBDAV_ATTACHMENT_RETRY_OPTIONS,
  type DropboxAccessTokenResolver,
  type MobileAttachmentFiles,
  type MobileAttachmentFileSystemPort,
} from './mobile-attachment-files';
import {
  assertAttachmentSyncNotAborted,
  CLOUD_ATTACHMENT_PRESENCE_MAX_CHECKS_PER_PASS,
  isAttachmentSyncAbortError,
  resolveAttachmentDownloadTargetPath,
  type MobileAttachmentCommon,
} from './mobile-attachment-common';
import type { MobileAttachmentInstaller } from './mobile-attachment-installer';
import type { MobileCloudSyncConfig, MobileSyncLogPort } from './mobile-sync-service';


export type MobileAttachmentBackendsCoreFunctions = {
  withRetry: typeof withRetry;
  webdavFileExists: typeof webdavFileExists;
  webdavGetFile: typeof webdavGetFile;
  webdavHeadFile: typeof webdavHeadFile;
  webdavMakeDirectory: typeof webdavMakeDirectory;
  webdavPutFileVersioned: typeof webdavPutFileVersioned;
  webdavConfirmUploadedFile: typeof webdavConfirmUploadedFile;
  cloudAttachmentExists: typeof cloudAttachmentExists;
  cloudGetFile: typeof cloudGetFile;
  cloudPutFile: typeof cloudPutFile;
  downloadDropboxFile: typeof downloadDropboxFile;
  getDropboxFileMetadata: typeof getDropboxFileMetadata;
  listDropboxFolderFiles: typeof listDropboxFolderFiles;
  uploadDropboxFileVersioned: typeof uploadDropboxFileVersioned;
  isDropboxConflictError(error: unknown): boolean;
  isDropboxFileNotFoundError(error: unknown): boolean;

  maxFileSyncBufferedPlaintextBytes(): number;
};

const CORE_FUNCTIONS: MobileAttachmentBackendsCoreFunctions = {
  withRetry,
  webdavFileExists,
  webdavGetFile,
  webdavHeadFile,
  webdavMakeDirectory,
  webdavPutFileVersioned,
  webdavConfirmUploadedFile,
  cloudAttachmentExists,
  cloudGetFile,
  cloudPutFile,
  downloadDropboxFile,
  getDropboxFileMetadata,
  listDropboxFolderFiles,
  uploadDropboxFileVersioned,
  isDropboxConflictError: (error) => error instanceof DropboxConflictError,
  isDropboxFileNotFoundError: (error) => error instanceof DropboxFileNotFoundError,
  maxFileSyncBufferedPlaintextBytes: () => MAX_FILE_SYNC_BUFFERED_PLAINTEXT_BYTES,
};

export type MobileAttachmentBackendsHost = {

  fs: MobileAttachmentFileSystemPort;
  files: MobileAttachmentFiles;
  common: MobileAttachmentCommon;

  installer: Pick<
    MobileAttachmentInstaller,
    | 'abandonFileSyncAttachmentPublication'
    | 'clearFileSyncAttachmentPublicationRecovery'
    | 'claimFileSyncAttachmentPublication'
    | 'completeFileSyncAttachmentPublication'
    | 'hashAttachmentFileGeneration'
    | 'publishImmutableAttachmentFileGeneration'
    | 'recoverFileSyncAttachmentPublications'
    | 'reserveFileSyncAttachmentPublication'
    | 'retainFileSyncAttachmentPublicationForInvalidTarget'
  >;
  log: Pick<MobileSyncLogPort, 'sanitize'>;


  maxWebdavBufferedUploadBytes?: number;

  maxCloudBufferedUploadBytes?: number;
  maxDropboxBufferedUploadBytes?: number;
  boundedWebdavResponses?: boolean;
  eagerFileSyncDownloads?: boolean;
  core?: Partial<MobileAttachmentBackendsCoreFunctions>;
};

export type CloudAttachmentSyncOptions = {
  activationProbe?: boolean;

  transferAdmission?: AttachmentTransferAdmission;
  assertCurrent?: () => void;
  assertRemoteMutationFenceHeld?: (minRemainingMs?: number) => Promise<void>;
  phase?: 'prepare' | 'post-merge';
  signal?: AbortSignal;
};

export type DropboxAttachmentSyncOptions = {
  activationProbe?: boolean;

  transferAdmission?: AttachmentTransferAdmission;
  phase?: 'prepare' | 'post-merge';
  resolveAccessToken?: DropboxAccessTokenResolver;
  signal?: AbortSignal;
  assertRemoteMutationFenceHeld?: (minRemainingMs?: number) => Promise<void>;

  material?: SyncKeyMaterial | null;
};

const CLOUD_REMOTE_MUTATION_REQUEST_HORIZON_MS = 35_000;


const downloadFilename = (attachment: Attachment): string => (
  attachment.cloudKey?.split('/').pop() || `${attachment.id}${extractExtension(attachment.title)}`
);


class LocalReadFailure extends Error {
  constructor(public readonly cause: unknown) {
    super('Attachment local file is unreadable');
  }
}


type PendingUploadMutation = {
  attachment: Attachment;
  cloudKey: string;
  fileHash: string;
  stat: LocalFileStat;
  fileSize?: number;
  totalBytes: number;
};

type DropboxDownloadCandidate = {
  attachment: Attachment;
  expectation: AttachmentDownloadExpectation;
  recoverPendingUpload: boolean;
};

const abortCheck = (message: string) => (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  const error = new Error(message);
  error.name = 'AbortError';
  throw error;
};

const assertCloudNotAborted = abortCheck('Attachment upload aborted');
const assertDropboxNotAborted = abortCheck('Dropbox attachment sync aborted');

const isAbortLikeError = (error: unknown, signal?: AbortSignal): boolean => (
  Boolean(signal?.aborted) || isAbortError(error)
);

export const createMobileAttachmentBackends = (host: MobileAttachmentBackendsHost) => {
  const core: MobileAttachmentBackendsCoreFunctions = { ...CORE_FUNCTIONS, ...host.core };
  const { fs, files, common, installer } = host;


  const adoptVerifiedDownloadTarget = async (attachment: Attachment, targetPath: string): Promise<boolean> => {
    const expected = attachment.fileHash?.trim().toLowerCase();
    if (!isSha256Hex(expected) || !targetPath) return false;
    if (await files.getLocalAttachmentPresence(targetPath).catch(() => 'unreadable' as const) !== 'present') return false;
    let actual: string | undefined;
    try {
      actual = (await installer.hashAttachmentFileGeneration(targetPath)).sha256?.trim().toLowerCase();
    } catch {
      return false;
    }
    if (actual !== expected) return false;
    attachment.uri = targetPath;
    attachment.localStatus = 'available';
    files.clearWebdavDownloadBackoff(attachment.id);
    files.logAttachmentInfo('Attachment download reused a verified local file', {
      attachmentId: attachment.id,
      kind: 'adopted',
      releaseCheck: 'v1.3.7/attachment-download-reuse',
    });
    return true;
  };
  const maxWebdavBufferedUploadBytes = host.maxWebdavBufferedUploadBytes;
  const maxCloudBufferedUploadBytes = host.maxCloudBufferedUploadBytes;
  const maxDropboxBufferedUploadBytes = host.maxDropboxBufferedUploadBytes;
  if (maxDropboxBufferedUploadBytes !== undefined && (!Number.isSafeInteger(maxDropboxBufferedUploadBytes) || maxDropboxBufferedUploadBytes <= 0))
    throw new Error('Dropbox buffered upload capability is invalid');
  if (maxWebdavBufferedUploadBytes !== undefined
    && (!Number.isSafeInteger(maxWebdavBufferedUploadBytes) || maxWebdavBufferedUploadBytes <= 0)) {
    throw new Error('WebDAV buffered upload capability is invalid');
  }
  if (maxCloudBufferedUploadBytes !== undefined
    && (!Number.isSafeInteger(maxCloudBufferedUploadBytes) || maxCloudBufferedUploadBytes <= 0)) {
    throw new Error('Cloud buffered upload capability is invalid');
  }

  const runWebdavAttachmentPass = async (
    appData: AppData,
    webDavConfig: MobileWebDavStoredConfig,
    baseSyncUrl: string,
    signal?: AbortSignal,
    options: {
      activationProbe?: boolean;
      activationContinuation?: boolean;
      phase?: 'prepare' | 'post-merge';

      material?: SyncKeyMaterial | null;
      assertRemoteMutationFenceHeld?: (minRemainingMs?: number) => Promise<void>;
      onTransferBatchDeferred?: () => void;

      transferAdmission?: AttachmentTransferAdmission;
    } = {}
  ): Promise<AppData | false> => {
    assertAttachmentSyncNotAborted(signal);
    const material = options.material ?? null;
    await common.assertEncryptionPosture(material);
    const maxBufferedPlaintextBytes = maxWebdavBufferedUploadBytes === undefined
      ? undefined
      : Math.max(0, maxWebdavBufferedUploadBytes - (material ? encryptedSyncArtifactByteLength(0) : 0));
    const assertUploadStat = maxBufferedPlaintextBytes === undefined ? undefined : (stat: LocalFileStat | null) => {


      assertBufferedAttachmentUploadSize(stat?.size ?? NaN, maxBufferedPlaintextBytes);
      if (material) {
        assertBufferedAttachmentUploadSize(encryptedSyncArtifactByteLength(stat!.size), maxWebdavBufferedUploadBytes!);
      }
    };
    let lastRequestAt = 0;
    let blockedUntil = 0;
    const waitForSlot = async (): Promise<void> => {
      assertAttachmentSyncNotAborted(signal);
      const now = Date.now();
      if (blockedUntil && now < blockedUntil) {
        throw new Error(`WebDAV rate limited for ${blockedUntil - now}ms`);
      }
      const elapsed = now - lastRequestAt;
      if (elapsed < WEBDAV_ATTACHMENT_MIN_INTERVAL_MS) {
        await common.waitForAttachmentSyncDelay(WEBDAV_ATTACHMENT_MIN_INTERVAL_MS - elapsed, signal);
      }
      assertAttachmentSyncNotAborted(signal);
      lastRequestAt = Date.now();
    };
    const handleRateLimit = (error: unknown): boolean => {
      if (!isWebdavRateLimitedError(error)) return false;
      blockedUntil = Date.now() + WEBDAV_ATTACHMENT_COOLDOWN_MS;
      files.logAttachmentWarn('WebDAV rate limited; pausing attachment sync', error);
      return true;
    };

    const attachmentsDirUrl = `${baseSyncUrl}/${ATTACHMENTS_DIR_NAME}`;


    assertMobileWebdavConnection(attachmentsDirUrl, webDavConfig.allowInsecureHttp);


    let attachmentsDirEnsured = false;
    const ensureRemoteAttachmentsDir = async (): Promise<void> => {
      if (attachmentsDirEnsured) return;
      try {
        await options.assertRemoteMutationFenceHeld?.(35_000);
        await core.webdavMakeDirectory(attachmentsDirUrl, {
          ...getMobileWebDavRequestOptions(webDavConfig.allowInsecureHttp),
          username: webDavConfig.username,
          password: webDavConfig.password,
          signal,
        });
      } catch (error) {
        if (isAttachmentSyncAbortError(error, signal)) throw error;
        if (isHostResponseTooLargeError(error)) throw error;
        if (isSyncRemoteMutationFenceError(error)) throw error;
        files.logAttachmentWarn('Failed to ensure WebDAV attachments directory', error);
      }


      attachmentsDirEnsured = true;
    };

    const attachmentsDir = await files.getAttachmentsDir();
    if (!attachmentsDir) return false;
    const attachmentsById = collectAttachmentsById(appData);

    if (!options.activationProbe) files.pruneWebdavDownloadBackoff();
    const reconcilePresence = options.activationProbe
      ? options.activationContinuation !== true
      : await files.isAttachmentPresenceReconciliationDue();
    files.logAttachmentInfo('WebDAV attachment sync start', {
      count: String(attachmentsById.size),
      presence: reconcilePresence ? 'reconcile' : 'skipped',
    });


    const allPatches = await common.migrateAttachmentsLocallyBeforeSync(
      attachmentsById, signal, maxBufferedPlaintextBytes, assertUploadStat,
    );

    let abortedByRateLimit = false;
    const presenceCandidates: Attachment[] = [];


    for (const attachment of attachmentsById.values()) {
      if (!reconcilePresence && !files.getWebdavDownloadBackoff(attachment.id)) continue;
      assertAttachmentSyncNotAborted(signal);
      if (attachment.kind !== 'file' || attachment.deletedAt) continue;

      const uri = attachment.uri || '';
      const isHttp = isHttpAttachmentUri(uri);
      const hasLocalPath = Boolean(uri) && !isHttp;
      const localPresence = hasLocalPath
        ? await files.getLocalAttachmentPresence(uri)
        : 'confirmed-not-found';
      if (localPresence === 'unreadable') {
        attachmentsById.delete(attachment.id);
        continue;
      }
      const existsLocally = localPresence === 'present';
      files.logAttachmentInfo('WebDAV attachment check', {
        id: attachment.id,
        uri: files.describeAttachmentUriForLog(uri),
        cloud: attachment.cloudKey ? 'set' : 'missing',
        local: hasLocalPath ? 'true' : 'false',
        exists: existsLocally ? 'true' : 'false',
      });

      if (existsLocally && !options.activationProbe && attachment.fileHash && files.getWebdavDownloadBackoff(attachment.id)) {
        const localHash = await files.computeAttachmentFileHash(uri);
        assertAttachmentSyncNotAborted(signal);
        if (localHash === attachment.fileHash.trim().toLowerCase()) files.clearWebdavDownloadBackoff(attachment.id);
      }

      if (reconcilePresence && hasLocalPath && existsLocally && !isHttp && isAttachmentPresenceRepairCandidate(attachment)) {
        presenceCandidates.push(attachment);
      }
    }

    if (reconcilePresence) {
      const presenceResult = await repairMissingRemoteAttachments({
        candidates: presenceCandidates,
        probe: async (attachment) => {
          try {
            const remoteExists = await core.withRetry(async () => {
              await waitForSlot();
              return await core.webdavFileExists(`${baseSyncUrl}/${attachment.cloudKey}`, {
                ...getMobileWebDavRequestOptions(webDavConfig.allowInsecureHttp),
                username: webDavConfig.username,
                password: webDavConfig.password,
                signal,
              });
            }, WEBDAV_ATTACHMENT_RETRY_OPTIONS);
            files.logAttachmentInfo('WebDAV attachment remote exists', {
              id: attachment.id,
              exists: remoteExists ? 'true' : 'false',
            });
            return remoteExists;
          } catch (error) {
            if (isAttachmentSyncAbortError(error, signal)) throw error;
            if (isHostResponseTooLargeError(error)) throw error;
            if (isSyncRemoteMutationFenceError(error) || isWebdavRemoteWriteConflictError(error)) throw error;
            if (handleRateLimit(error)) abortedByRateLimit = true;
            else files.logAttachmentWarn('WebDAV attachment remote check failed', error);
            return null;
          }
        },
        clear: (attachment) => {
          const patched: Attachment = { ...attachment, cloudKey: undefined };
          allPatches.set(patched.id, patched);
          attachmentsById.set(patched.id, patched);
          if (!options.activationProbe) files.clearWebdavDownloadBackoff(attachment.id);
        },
      });
      files.logAttachmentInfo('WebDAV attachment presence proof finished', {
        releaseCheck: 'v1.3.0/webdav-presence-proof',
        checked: String(presenceResult.checked),
        cleared: String(presenceResult.cleared),
        complete: presenceResult.complete ? 'true' : 'false',
      });
      if (presenceResult.complete && !options.activationProbe) {
        await files.markAttachmentPresenceReconciled();
      }
    }


    let uploadCount = 0;
    let uploadLimitLogged = false;
    let downloadCount = 0;
    let downloadLimitLogged = false;
    const unversionedRemote = { adopted: 0, refused: 0 };


    const remoteHoldsLocalBytes = async (
      uploadUrl: string, cloudKey: string, localPath: string, statedLength: string | null,
    ): Promise<boolean> => {
      if (!host.boundedWebdavResponses) return false;

      const size = (await files.statAttachmentFile(localPath))?.size;
      if (size === undefined) return false;
      const wireBytes = material ? encryptedSyncArtifactByteLength(size) : size;
      const stated = statedLength?.trim();
      if (stated && Number(stated) !== wireBytes) return false;
      let remote: Uint8Array;
      try {
        const body = await core.withRetry(async () => {
          await waitForSlot();
          return await core.webdavGetFile(uploadUrl, {
            ...getMobileWebDavRequestOptions(webDavConfig.allowInsecureHttp),
            username: webDavConfig.username,
            password: webDavConfig.password,
            signal,
            maxBytes: wireBytes,
          });
        }, WEBDAV_ATTACHMENT_RETRY_OPTIONS);
        remote = new Uint8Array(body);
        if (remote.byteLength !== wireBytes) return false;
        if (material && inspectSyncArtifact(remote).kind !== 'encrypted') return false;
        remote = await common.openAttachmentBytesFromDownload(remote, material, cloudKey);
      } catch (error) {
        if (isAttachmentSyncAbortError(error, signal) || isWebdavRateLimitedError(error)) throw error;
        return false;
      }
      const localHash = await files.computeAttachmentFileHash(localPath);
      return localHash !== null && localHash === await computeSha256Hex(remote);
    };

    const shouldUpload = (): boolean => {
      if (uploadCount >= WEBDAV_ATTACHMENT_MAX_UPLOADS_PER_SYNC) {
        if (!uploadLimitLogged) {
          files.logAttachmentInfo('WebDAV attachment upload limit reached', {
            limit: String(WEBDAV_ATTACHMENT_MAX_UPLOADS_PER_SYNC),
          });
          uploadLimitLogged = true;
        }
        options.onTransferBatchDeferred?.();
        return false;
      }
      uploadCount += 1;
      return true;
    };

    const shouldDownload = (attachment: Attachment): boolean => {


      if (!options.activationProbe && files.getWebdavDownloadBackoff(attachment.id)) return false;
      if (downloadCount >= WEBDAV_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC) {
        if (!downloadLimitLogged) {
          files.logAttachmentInfo('WebDAV attachment download limit reached', {
            limit: String(WEBDAV_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC),
          });
          downloadLimitLogged = true;
        }
        options.onTransferBatchDeferred?.();
        return false;
      }
      downloadCount += 1;
      return true;
    };

    const { patches } = await common.runMobileAttachmentLifecycle({
      attachmentsById,
      getLocalFilePresence: files.getLocalAttachmentPresence,
      deferUploads: options.phase === 'prepare',
      admission: options.activationProbe ? undefined : options.transferAdmission,
      adoptExistingDownload: options.activationProbe ? undefined : (attachment) => (
        adoptVerifiedDownloadTarget(attachment, `${attachmentsDir}${downloadFilename(attachment)}`)
      ),
      getLocalFileStat: (path) => files.statAttachmentFile(path),
      computeLocalFileHash: (path) => files.computeAttachmentFileHash(path),
      contentChangePhase: options.phase,
      maxBufferedUploadBytes: maxBufferedPlaintextBytes,
      assertUploadStat,
      isFatalError: (error) => (
        isAttachmentSyncAbortError(error, signal)
        || isHostResponseTooLargeError(error)
        || isSyncRemoteMutationFenceError(error)
        || isWebdavRemoteWriteConflictError(error)
        || (maxWebdavBufferedUploadBytes !== undefined && isAttachmentUploadAdmissionError(error))
      ),
      policy: {
        shouldSkip: () => abortedByRateLimit,
        shouldUpload,
        shouldDownload,
      },
      onUpload: async (attachment, localPath) => {
        try {
          await ensureRemoteAttachmentsDir();
          let size = await files.getAttachmentByteSize(attachment, localPath);
          let fileData: Uint8Array | null = null;
          if (!Number.isFinite(size ?? NaN)) {
            const readResult = await files.readAttachmentBytesForUpload(localPath);
            if (readResult.readFailed) throw new LocalReadFailure(readResult.error);
            fileData = readResult.data;
            size = fileData.byteLength;
          }
          const validation = await validateAttachmentForUpload(attachment, size);
          if (!validation.valid) {
            files.logAttachmentWarn(`Attachment validation failed (${validation.error}) for ${attachment.id}`);
            return false;
          }
          const cloudKey = buildCloudKey(attachment);
          const startedAt = Date.now();
          const uploadBytes = Math.max(0, Number(size ?? 0));
          reportProgress(attachment.id, 'upload', 0, uploadBytes, 'active');
          const uploadUrl = `${baseSyncUrl}/${cloudKey}`;
          const remoteVersion = await core.withRetry(async () => {
            await waitForSlot();
            return core.webdavHeadFile(uploadUrl, {
              ...getMobileWebDavRequestOptions(webDavConfig.allowInsecureHttp),
              username: webDavConfig.username,
              password: webDavConfig.password,
              signal,
            });
          }, WEBDAV_ATTACHMENT_RETRY_OPTIONS);
          const expectedEtag = remoteVersion.exists
            ? normalizeStrongWebdavEtag(remoteVersion.etag)
            : null;
          if (remoteVersion.exists && !expectedEtag) {
            if (!await remoteHoldsLocalBytes(uploadUrl, cloudKey, localPath, remoteVersion.contentLength)) {
              unversionedRemote.refused += 1;
              throw new Error('WebDAV attachment version is unavailable; refusing an unconditional overwrite');
            }
            unversionedRemote.adopted += 1;
            attachment.cloudKey = cloudKey;
            if (!Number.isFinite(attachment.size ?? NaN)) attachment.size = uploadBytes;
            reportProgress(attachment.id, 'upload', uploadBytes, uploadBytes, 'completed');
            return true;
          }
          files.logAttachmentInfo('WebDAV attachment upload start', {
            id: attachment.id,
            bytes: String(uploadBytes),
            cloudKey,
          });


          const uploadedWithFileSystem = material ? false : await core.withRetry(
            async () => {
              await waitForSlot();
              await options.assertRemoteMutationFenceHeld?.(35_000);
              return await common.uploadWebdavFileWithFileSystem(
                uploadUrl,
                localPath,
                attachment.mimeType || DEFAULT_ATTACHMENT_CONTENT_TYPE,
                webDavConfig.username,
                webDavConfig.password,
                webDavConfig.allowInsecureHttp,
                (loaded, total) => reportProgress(attachment.id, 'upload', loaded, total, 'active'),
                uploadBytes,
                signal,
                expectedEtag,
              );
            },
            {
              ...WEBDAV_ATTACHMENT_RETRY_OPTIONS,
              onRetry: (error, attempt, delayMs) => {
                files.logAttachmentInfo('Retrying WebDAV attachment upload', {
                  id: attachment.id,
                  attempt: String(attempt + 1),
                  delayMs: String(delayMs),
                  error: host.log.sanitize(error instanceof Error ? error.message : String(error)),
                });
              },
            }
          );


          const findUploadAtUrl = async () => {
            const sentBytes = (await files.statAttachmentFile(localPath))?.size ?? uploadBytes;
            return core.withRetry(async () => {
              await waitForSlot();
              return core.webdavConfirmUploadedFile(uploadUrl, sentBytes, {
                ...getMobileWebDavRequestOptions(webDavConfig.allowInsecureHttp),
                username: webDavConfig.username,
                password: webDavConfig.password,
                signal,
              });
            }, WEBDAV_ATTACHMENT_RETRY_OPTIONS);
          };
          let storedByStream = uploadedWithFileSystem;
          if (uploadedWithFileSystem) {
            const landed = await findUploadAtUrl();
            if (landed.redirected) {


              storedByStream = false;
              files.logAttachmentInfo('WebDAV streamed upload unproven after a redirected HEAD; sending it through the checked PUT', {
                id: attachment.id,
                releaseCheck: 'v1.3.4/streamed-upload-head-fallback',
              });
            } else if (!landed.confirmed) {
              refuseWriteRedirect({ releaseCheck: 'v1.3.4/fetch-redirect-refused-upload', method: 'PUT', status: landed.status });
            }
          }
          if (!storedByStream) {
            let uploadData = fileData;
            if (!uploadData) {
              const readResult = await files.readAttachmentBytesForUpload(localPath);
              if (readResult.readFailed) throw new LocalReadFailure(readResult.error);
              uploadData = readResult.data;
            }
            const buffer = toAttachmentArrayBuffer(await common.sealAttachmentBytesForUpload(uploadData, material, cloudKey));
            try {
              await core.withRetry(
                async () => {
                  await waitForSlot();
                  await options.assertRemoteMutationFenceHeld?.(35_000);
                  return await core.webdavPutFileVersioned(uploadUrl, buffer, attachment.mimeType || DEFAULT_ATTACHMENT_CONTENT_TYPE, expectedEtag, {
                    ...getMobileWebDavRequestOptions(webDavConfig.allowInsecureHttp),
                    username: webDavConfig.username,
                    password: webDavConfig.password,
                    signal,
                  });
                },
                {
                  ...WEBDAV_ATTACHMENT_RETRY_OPTIONS,
                  onRetry: (error, attempt, delayMs) => {
                    files.logAttachmentInfo('Retrying WebDAV attachment upload', {
                      id: attachment.id,
                      attempt: String(attempt + 1),
                      delayMs: String(delayMs),
                      error: host.log.sanitize(error instanceof Error ? error.message : String(error)),
                    });
                  },
                }
              );
            } catch (error) {


              if (isHostResponseTooLargeError(error)) throw error;
              if (!(uploadedWithFileSystem && getErrorStatus(error) === 412)) throw error;
              const stored = await findUploadAtUrl();
              if (!stored.confirmed) {
                refuseWriteRedirect({ releaseCheck: 'v1.3.4/fetch-redirect-refused-upload', method: 'PUT', status: stored.status });
              }
              files.logAttachmentInfo('WebDAV attachment already stored by the streamed upload', { id: attachment.id });
            }
          }
          attachment.cloudKey = cloudKey;
          if (!Number.isFinite(attachment.size ?? NaN) && Number.isFinite(size ?? NaN)) {
            attachment.size = Number(size);
          }


          reportProgress(attachment.id, 'upload', uploadBytes, uploadBytes, 'completed');
          files.logAttachmentInfo('Attachment uploaded', {
            id: attachment.id,
            bytes: String(uploadBytes),
            ms: String(Date.now() - startedAt),
          });
          return true;
        } catch (error) {
          if (isAttachmentSyncAbortError(error, signal)) throw error;
          if (isHostResponseTooLargeError(error)) throw error;
          if (isSyncRemoteMutationFenceError(error) || isWebdavRemoteWriteConflictError(error)) throw error;
          if (handleRateLimit(error)) {
            abortedByRateLimit = true;
            return false;
          }
          if (error instanceof LocalReadFailure) {
            const mutated = markAttachmentUnrecoverable(attachment);
            files.logAttachmentWarn(
              `Attachment local file is unreadable; marking unrecoverable (${attachment.id})`,
              error.cause
            );
            return mutated;
          }
          reportProgress(
            attachment.id,
            'upload',
            0,
            attachment.size ?? 0,
            'failed',
            error instanceof Error ? error.message : String(error)
          );
          files.logAttachmentWarn(`Failed to upload attachment ${attachment.id}`, error);
          return false;
        }
      },
      onUploadError: () => {


      },
      onDownload: async (attachment, expectation) => {
        if (!attachment.cloudKey) return false;
        const cloudKey = attachment.cloudKey;
        let fileData: ArrayBuffer;
        try {
          fileData = await core.withRetry(async () => {
            await waitForSlot();
            return await core.webdavGetFile(`${baseSyncUrl}/${cloudKey}`, {
              ...getMobileWebDavRequestOptions(webDavConfig.allowInsecureHttp),
              username: webDavConfig.username,
              password: webDavConfig.password,
              signal,
              onProgress: (loaded, total) => reportProgress(attachment.id, 'download', loaded, total, 'active'),
            });
          }, WEBDAV_ATTACHMENT_RETRY_OPTIONS);
        } catch (error) {
          if (isAttachmentSyncAbortError(error, signal)) throw error;
          if (isHostResponseTooLargeError(error)) throw error;
          if (handleRateLimit(error)) {
            abortedByRateLimit = true;
            return false;
          }
          const status = getErrorStatus(error);
          if (status === 404) {

            if (!options.activationProbe) files.setWebdavDownloadBackoff(attachment.id, error);
            files.logAttachmentInfo('WebDAV attachment not found (404); row kept', {
              id: attachment.id,
              releaseCheck: 'v1.3.8/attachment-not-found-kept',
            });
            return handleRemoteAttachmentNotFound(attachment, options.activationProbe === true);
          }
          throw error;
        }


        const bytes = await common.openAttachmentBytesFromDownload(
          fileData instanceof ArrayBuffer ? new Uint8Array(fileData) : new Uint8Array(fileData as ArrayBuffer),
          material,
          cloudKey,
        );
        await validateAttachmentHash(attachment, bytes);
        const targetUri = resolveAttachmentDownloadTargetPath(
          attachment,
          `${attachmentsDir}${downloadFilename(attachment)}`,
          expectation,
        );
        const installed = await common.installAttachmentDownloadBytes(
          attachment,
          attachmentsDir,
          targetUri,
          bytes,
          expectation,
          signal,
        );
        if (!installed) return false;
        attachment.uri = targetUri;
        const statusChanged = attachment.localStatus !== 'available';
        if (statusChanged) {
          attachment.localStatus = 'available';
        }
        if (!options.activationProbe) files.clearWebdavDownloadBackoff(attachment.id);
        reportProgress(attachment.id, 'download', bytes.length, bytes.length, 'completed');
        return statusChanged;
      },
      onDownloadError: (attachment, error) => {


        if (!options.activationProbe) files.setWebdavDownloadBackoff(attachment.id, error);
        reportProgress(
          attachment.id,
          'download',
          0,
          attachment.size ?? 0,
          'failed',
          error instanceof Error ? error.message : String(error)
        );
        files.logAttachmentWarn(`Failed to download attachment ${attachment.id}`, error);
      },
    });

    for (const patch of patches.values()) allPatches.set(patch.id, patch);
    const nextData = applyAttachmentPatches(appData, allPatches);
    const didMutate = nextData !== appData;

    if (abortedByRateLimit) {
      files.logAttachmentWarn('WebDAV attachment sync aborted due to rate limiting');
    }
    if (unversionedRemote.adopted || unversionedRemote.refused) {
      files.logAttachmentInfo('WebDAV attachments without a strong ETag compared by content', {
        releaseCheck: 'v1.3.7/webdav-weak-etag-adopt',
        adopted: String(unversionedRemote.adopted),
        refused: String(unversionedRemote.refused),
      });
    }
    files.logAttachmentInfo('WebDAV attachment sync done', {
      mutated: didMutate ? 'true' : 'false',
    });
    return didMutate ? nextData : false;
  };

  const syncWebdavAttachments = async (
    ...args: Parameters<typeof runWebdavAttachmentPass>
  ): Promise<AppData | false> => {
    try {
      return await runWebdavAttachmentPass(...args);
    } catch (error) {
      if (isHostResponseTooLargeError(error)) {
        try {
          files.logAttachmentWarn('WebDAV host download limit refused', undefined, {
            releaseCheck: 'v1.3.5/webdav-host-download-limit', operation: 'download', outcome: 'refused',
          });
        } catch {

        }
        throw error;
      }
      if (maxWebdavBufferedUploadBytes !== undefined && isAttachmentUploadAdmissionError(error)) {
        try {
          files.logAttachmentWarn('WebDAV host upload admission refused', undefined, {
            releaseCheck: 'v1.3.5/webdav-host-upload-limit', operation: 'upload', outcome: 'refused',
          });
        } catch {

        }
        throw new WebdavHostUploadLimitError();
      }
      throw error;
    }
  };

  const runCloudAttachmentPass = async (
    appData: AppData,
    cloudConfig: MobileCloudSyncConfig,
    baseSyncUrl: string,
    options: CloudAttachmentSyncOptions = {}
  ): Promise<AppData | false> => {
    await common.assertEncryptionPosture(null);
    const attachmentsDir = await files.getAttachmentsDir();

    const attachmentsById = collectAttachmentsById(appData);


    const allPatches = await common.migrateAttachmentsLocallyBeforeSync(attachmentsById, options.signal, maxCloudBufferedUploadBytes);
    const recordPatch = (attachment: Attachment): void => {
      allPatches.set(attachment.id, attachment);
      attachmentsById.set(attachment.id, attachment);
    };

    const pendingUploadMutations: PendingUploadMutation[] = [];
    const cloudRequestOptions = getMobileCloudRequestOptions(cloudConfig.allowInsecureHttp);


    const reconcilePresence = options.activationProbe || await files.isAttachmentPresenceReconciliationDue();
    const presenceProven = !reconcilePresence || await common.reconcileRemoteAttachmentPresence({
      label: 'Cloud',
      attachmentsById,
      recordPatch,
      signal: options.signal,
      maxChecks: CLOUD_ATTACHMENT_PRESENCE_MAX_CHECKS_PER_PASS,
      createProbe: async () => (attachment) => core.cloudAttachmentExists(
        `${baseSyncUrl}/${attachment.cloudKey}`,
        {
          ...cloudRequestOptions,
          token: cloudConfig.token,
          ...(options.signal ? { signal: options.signal } : {}),


          partialBodyReads: false,
          onHeadUnsupported: () => files.logAttachmentInfo('Sync server is too old for attachment presence checks', {
            reason: 'no-head-route',
          }),
        },
      ),
    });

    for (const original of attachmentsById.values()) {
      if (original.kind !== 'file') continue;
      if (original.deletedAt) continue;

      const attachment: Attachment = { ...original };

      const uri = attachment.uri || '';
      const isHttp = isHttpAttachmentUri(uri);
      const hasLocalPath = Boolean(uri) && !isHttp;
      const localPresence = hasLocalPath
        ? await files.getLocalAttachmentPresence(uri)
        : 'confirmed-not-found';
      if (localPresence === 'unreadable') continue;
      const existsLocally = localPresence === 'present';


      if (
        options.phase !== 'prepare'
        && attachment.pendingContentUpload === true
        && !existsLocally
      ) continue;
      const nextStatus = getAttachmentLocalStatus(uri, localPresence);
      if (attachment.localStatus !== nextStatus) {
        attachment.localStatus = nextStatus;
        recordPatch(attachment);
      }

      const mayUploadLocalFile = hasLocalPath
        && existsLocally
        && !isHttp
        && files.canUploadAttachmentFrom(uri);
      if (
        options.phase === 'prepare'
        && (attachment.cloudKey || attachment.pendingContentUpload === true)
        && mayUploadLocalFile
      ) {
        if (await common.prepareBespokeAttachmentContentCandidate(attachment, uri, maxCloudBufferedUploadBytes)) {
          recordPatch(attachment);
        }
      }

      let remoteWinnerExpectation: AttachmentDownloadExpectation | undefined;
      if (
        !options.activationProbe
        && options.phase === 'post-merge'
        && attachment.cloudKey
        && mayUploadLocalFile
        && attachment.pendingContentUpload !== true
      ) {
        const contentCheck = await common.checkBespokeAttachmentRemoteWinner(attachment, uri, maxCloudBufferedUploadBytes);
        if (contentCheck.metadataChanged) recordPatch(attachment);
        if (contentCheck.kind === 'local-edit-race') {
          files.logAttachmentWarn(`Skipped remote attachment replacement after a local edit race (${attachment.id})`);
        } else if (contentCheck.kind === 'download') {
          remoteWinnerExpectation = contentCheck.expectation;
        }
      }

      if (
        options.activationProbe
        && options.phase !== 'prepare'
        && attachment.cloudKey
        && !existsLocally
        && !isHttp
        && attachmentsDir
      ) {
        try {
          assertCloudNotAborted(options.signal);
          reportProgress(attachment.id, 'download', 0, attachment.size ?? 0, 'active');
          const data = await core.cloudGetFile(
            `${baseSyncUrl}/${attachment.cloudKey}`,
            options.signal
              ? { ...cloudRequestOptions, token: cloudConfig.token, signal: options.signal }
              : { ...cloudRequestOptions, token: cloudConfig.token },
          );
          const bytes = new Uint8Array(data);
          await validateAttachmentHash(attachment, bytes);
          const fileHash = await computeSha256Hex(bytes);
          if (!fileHash) throw new Error('Attachment download hash is unavailable');
          const targetUri = `${attachmentsDir}${downloadFilename(attachment)}`;
          assertCloudNotAborted(options.signal);
          const installed = await common.installAttachmentDownloadBytes(
            attachment,
            attachmentsDir,
            targetUri,
            bytes,
            { kind: 'absent' },
            options.signal,
          );
          if (!installed) {
            reportProgress(
              attachment.id,
              'download',
              0,
              attachment.size ?? 0,
              'failed',
              'Local attachment changed during download',
            );
            files.logAttachmentWarn(`Skipped candidate attachment download after a native conflict (${attachment.id})`);
            continue;
          }
          attachment.uri = targetUri;
          attachment.fileHash = attachment.fileHash || fileHash;
          attachment.localStatus = 'available';
          recordPatch(attachment);
          reportProgress(attachment.id, 'download', bytes.length, bytes.length, 'completed');
        } catch (error) {
          if (isHostResponseTooLargeError(error)) throw error;
          if (isAbortLikeError(error, options.signal)) throw error;
          reportProgress(
            attachment.id,
            'download',
            0,
            attachment.size ?? 0,
            'failed',
            error instanceof Error ? error.message : String(error),
          );
          files.logAttachmentWarn(`Failed to prove candidate attachment ${attachment.id}`, error);
        }
        continue;
      }


      if (remoteWinnerExpectation && attachmentsDir && attachment.cloudKey) {
        try {
          assertCloudNotAborted(options.signal);
          reportProgress(attachment.id, 'download', 0, attachment.size ?? 0, 'active');
          const data = await core.cloudGetFile(
            `${baseSyncUrl}/${attachment.cloudKey}`,
            options.signal
              ? { ...cloudRequestOptions, token: cloudConfig.token, signal: options.signal }
              : { ...cloudRequestOptions, token: cloudConfig.token },
          );
          const bytes = new Uint8Array(data);
          await validateAttachmentHash(attachment, bytes);
          assertCloudNotAborted(options.signal);
          const installed = await common.installAttachmentDownloadBytes(
            attachment,
            attachmentsDir,
            uri,
            bytes,
            remoteWinnerExpectation,
            options.signal,
          );
          if (!installed) {
            files.logAttachmentWarn(`Skipped remote attachment replacement after a native conflict (${attachment.id})`);
            continue;
          }
          attachment.localStatus = 'available';
          await common.refreshBespokeAttachmentDownloadedContentStat(attachment, uri);
          recordPatch(attachment);
          reportProgress(attachment.id, 'download', bytes.length, bytes.length, 'completed');
        } catch (error) {
          if (isHostResponseTooLargeError(error)) throw error;
          if (isAbortLikeError(error, options.signal)) throw error;
          reportProgress(
            attachment.id,
            'download',
            0,
            attachment.size ?? 0,
            'failed',
            error instanceof Error ? error.message : String(error),
          );
          files.logAttachmentWarn(`Failed to download remote attachment winner ${attachment.id}`, error);
        }
        continue;
      }


      if (
        options.phase !== 'prepare'
        && (!attachment.cloudKey || attachment.pendingContentUpload === true)
        && mayUploadLocalFile
      ) {
        if (!files.shouldAttemptAttachmentUpload(attachment)) continue;
        if (!options.activationProbe && options.transferAdmission) {
          if (options.transferAdmission.has(attachment, 'upload')) continue;
          options.transferAdmission.record(attachment, 'upload');
        }
        let shouldPropagateError = false;
        let snapshot: Awaited<ReturnType<typeof common.createMobileAttachmentUploadSnapshot>> = null;
        try {
          assertCloudNotAborted(options.signal);
          try {
            options.assertCurrent?.();
          } catch (error) {
            shouldPropagateError = true;
            throw error;
          }
          snapshot = await common.createMobileAttachmentUploadSnapshotWithLimit(uri, attachment, maxCloudBufferedUploadBytes);
          if (!snapshot) continue;
          if (
            attachment.pendingContentUpload === true
            && snapshot.fileHash !== attachment.fileHash?.trim().toLowerCase()
          ) {
            continue;
          }
          const fileSize = snapshot.stat.size;

          const validation = await validateAttachmentForUpload(attachment, fileSize);
          if (!validation.valid) {
            files.logAttachmentWarn(`Attachment validation failed (${validation.error}) for ${attachment.id}`);
            continue;
          }
          const totalBytes = Math.max(0, Number(fileSize ?? 0));
          reportProgress(attachment.id, 'upload', 0, totalBytes, 'active');
          const cloudKey = buildCloudKey(attachment);
          const uploadUrl = `${baseSyncUrl}/${cloudKey}`;
          try {
            await options.assertRemoteMutationFenceHeld?.(CLOUD_REMOTE_MUTATION_REQUEST_HORIZON_MS);
          } catch (error) {
            shouldPropagateError = true;
            throw error;
          }


          assertCloudNotAborted(options.signal);
          const readResult = await files.readAttachmentBytesForUpload(snapshot.sourcePath);
          if (readResult.readFailed) throw readResult.error;
          if (maxCloudBufferedUploadBytes !== undefined) {
            assertBufferedAttachmentUploadSize(readResult.data.byteLength, maxCloudBufferedUploadBytes);
          }
          const buffer = toAttachmentArrayBuffer(readResult.data);
          try {
            await options.assertRemoteMutationFenceHeld?.(CLOUD_REMOTE_MUTATION_REQUEST_HORIZON_MS);
          } catch (error) {
            shouldPropagateError = true;
            throw error;
          }
          await common.assertEncryptionPosture(null);
          await core.cloudPutFile(
            uploadUrl,
            buffer,
            attachment.mimeType || DEFAULT_ATTACHMENT_CONTENT_TYPE,
            options.signal
              ? { ...cloudRequestOptions, token: cloudConfig.token, signal: options.signal }
              : { ...cloudRequestOptions, token: cloudConfig.token }
          );
          try {
            options.assertCurrent?.();
          } catch (error) {
            shouldPropagateError = true;
            throw error;
          }
          pendingUploadMutations.push({
            attachment,
            cloudKey,
            fileHash: snapshot.fileHash,
            stat: snapshot.stat,
            fileSize: Number.isFinite(fileSize ?? NaN) ? Number(fileSize) : undefined,
            totalBytes,
          });
        } catch (error) {
          if (isHostResponseTooLargeError(error)) throw error;
          if (maxCloudBufferedUploadBytes !== undefined && isAttachmentUploadAdmissionError(error)) throw error;
          if (shouldPropagateError || isAbortLikeError(error, options.signal)) {


            throw error;
          }
          const status = Number((error as { status?: unknown } | null)?.status);


          const refusesTheseBytes = status === 413
            || (status === 400 && isBlockedAttachmentContentRefusal(error));
          if (refusesTheseBytes && !options.activationProbe) {
            const failure = files.handleAttachmentUploadRefusal(
              attachment,
              status === 413 ? 'server_file_too_large' : 'server_rejected',
            );
            if (failure.mutated) recordPatch(attachment);
            reportProgress(attachment.id, 'upload', 0, attachment.size ?? 0, 'failed', failure.message);
            files.logAttachmentWarn(failure.logMessage);
            if (
              failure.reachedLimit
              && !failure.mutated
              && attachment.pendingContentUpload === true
              && attachment.cloudKey !== undefined
            ) {
              files.logAttachmentWarn(
                'Attachment replacement retained after upload refusal',
                undefined,
                { releaseCheck: 'v1.3.2/attachment-replacement-held' },
              );
            }
            continue;
          }
          reportProgress(
            attachment.id,
            'upload',
            0,
            attachment.size ?? 0,
            'failed',
            error instanceof Error ? error.message : String(error)
          );
          files.logAttachmentWarn(`Failed to upload attachment ${attachment.id}`, error);
        } finally {
          if (snapshot) {
            await snapshot.dispose().catch((error) => {
              files.logAttachmentWarn(`Failed to clean up attachment upload snapshot ${attachment.id}`, error);
            });
          }
        }
      }
    }

    for (const pending of pendingUploadMutations) {
      files.clearAttachmentUploadRefusal(pending.attachment.id);
      pending.attachment.cloudKey = pending.cloudKey;
      pending.attachment.pendingContentUpload = undefined;
      applyAttachmentContentStat(pending.attachment, pending.stat, pending.fileHash);
      if (!Number.isFinite(pending.attachment.size ?? NaN) && Number.isFinite(pending.fileSize ?? NaN)) {
        pending.attachment.size = Number(pending.fileSize);
      }
      pending.attachment.localStatus = 'available';
      recordPatch(pending.attachment);
      reportProgress(pending.attachment.id, 'upload', pending.totalBytes, pending.totalBytes, 'completed');
    }


    if (reconcilePresence && presenceProven && !options.activationProbe) {
      await files.markAttachmentPresenceReconciled();
    }

    const nextData = applyAttachmentPatches(appData, allPatches);
    return nextData !== appData ? nextData : false;
  };

  const syncCloudAttachments = async (
    ...args: Parameters<typeof runCloudAttachmentPass>
  ): Promise<AppData | false> => {
    try {
      return await runCloudAttachmentPass(...args);
    } catch (error) {
      if (isHostResponseTooLargeError(error)) {
        try {
          files.logAttachmentWarn('Cloud host response limit refused', undefined, {
            releaseCheck: 'v1.3.5/cloud-host-response-limit', operation: 'response', outcome: 'refused',
          });
        } catch {

        }
        throw error;
      }
      if (maxCloudBufferedUploadBytes !== undefined && isAttachmentUploadAdmissionError(error)) {
        try {
          files.logAttachmentWarn('Cloud host upload admission refused', undefined, {
            releaseCheck: 'v1.3.5/cloud-host-upload-limit', operation: 'upload', outcome: 'refused',
          });
        } catch {

        }
        throw new CloudHostUploadLimitError();
      }
      throw error;
    }
  };

  const runDropboxAttachmentPass = async (
    appData: AppData,
    dropboxClientId: string,
    fetcher: typeof fetch,
    options: DropboxAttachmentSyncOptions = {}
  ): Promise<AppData | false> => {
    await common.assertEncryptionPosture(options.material);
    if (!dropboxClientId) return false;
    const plaintextLimit = maxDropboxBufferedUploadBytes === undefined ? undefined
      : Math.max(0, maxDropboxBufferedUploadBytes - (options.material ? encryptedSyncArtifactByteLength(0) : 0));
    const attachmentsDir = await files.getAttachmentsDir();
    const attachmentsById = collectAttachmentsById(appData);
    const allPatches = await common.migrateAttachmentsLocallyBeforeSync(attachmentsById, options.signal, plaintextLimit);
    const recordPatch = (attachment: Attachment): void => {
      allPatches.set(attachment.id, attachment);
      attachmentsById.set(attachment.id, attachment);
    };
    const foldPatches = (): AppData | false => {
      const nextData = applyAttachmentPatches(appData, allPatches);
      return nextData !== appData ? nextData : false;
    };


    const reconcilePresence = options.activationProbe || await files.isAttachmentPresenceReconciliationDue();
    const presenceProven = !reconcilePresence || await common.reconcileRemoteAttachmentPresence({
      label: 'Dropbox',
      attachmentsById,
      recordPatch,
      signal: options.signal,
      createProbe: async () => {
        try {
          const isPresent = createDropboxAttachmentPresenceIndex(await files.runDropboxAuthorized(
            dropboxClientId,
            (accessToken) => core.listDropboxFolderFiles(
              accessToken,
              DROPBOX_ATTACHMENTS_PATH,
              fetcher,
              { signal: options.signal },
            ),
            fetcher,
            options.resolveAccessToken,
          ));
          return async (attachment) => isPresent(attachment.cloudKey ?? '');
        } catch (error) {
          if (isAbortLikeError(error, options.signal)) throw error;
          files.logAttachmentWarn('Failed to list Dropbox attachments for the presence pass', error);
          return null;
        }
      },
    });

    const downloadQueue: DropboxDownloadCandidate[] = [];
    const pendingUploadMutations: PendingUploadMutation[] = [];
    let uploadCount = 0;
    let uploadLimitLogged = false;

    for (const original of attachmentsById.values()) {
      if (original.kind !== 'file') continue;
      if (original.deletedAt) continue;

      const attachment: Attachment = { ...original };

      const uri = attachment.uri || '';
      const isHttp = isHttpAttachmentUri(uri);
      const isContent = isContentAttachmentUri(uri);
      const hasLocalPath = Boolean(uri) && !isHttp;
      const localPresence = hasLocalPath
        ? await files.getLocalAttachmentPresence(uri)
        : 'confirmed-not-found';
      if (localPresence === 'unreadable') continue;
      const existsLocally = localPresence === 'present';
      if (existsLocally) files.clearWebdavDownloadBackoff(attachment.id);
      const nextStatus = getAttachmentLocalStatus(uri, localPresence);
      if (attachment.localStatus !== nextStatus) {
        attachment.localStatus = nextStatus;
        recordPatch(attachment);
      }

      const mayUploadLocalFile = hasLocalPath
        && existsLocally
        && !isHttp
        && files.canUploadAttachmentFrom(uri);
      if (
        options.phase === 'prepare'
        && (attachment.cloudKey || attachment.pendingContentUpload === true)
        && mayUploadLocalFile
      ) {
        if (await common.prepareBespokeAttachmentContentCandidate(attachment, uri, plaintextLimit)) {
          recordPatch(attachment);
        }
      }

      if (
        !options.activationProbe
        && options.phase === 'post-merge'
        && attachment.cloudKey
        && mayUploadLocalFile
        && attachment.pendingContentUpload !== true
      ) {
        const contentCheck = await common.checkBespokeAttachmentRemoteWinner(attachment, uri, plaintextLimit);
        if (contentCheck.metadataChanged) recordPatch(attachment);
        if (contentCheck.kind === 'local-edit-race') {
          files.logAttachmentWarn(`Skipped remote attachment replacement after a local edit race (${attachment.id})`);
        } else if (contentCheck.kind === 'download') {
          downloadQueue.push({
            attachment,
            expectation: contentCheck.expectation,
            recoverPendingUpload: false,
          });
        }
      }


      if (
        options.phase !== 'prepare'
        && (!attachment.cloudKey || attachment.pendingContentUpload === true)
        && mayUploadLocalFile
      ) {
        if (!options.activationProbe && options.transferAdmission?.has(attachment, 'upload')) continue;
        if (!options.activationProbe && uploadCount >= DROPBOX_ATTACHMENT_MAX_UPLOADS_PER_SYNC) {
          if (!uploadLimitLogged) {
            uploadLimitLogged = true;
            files.logAttachmentInfo('Dropbox attachment upload limit reached', {
              limit: String(DROPBOX_ATTACHMENT_MAX_UPLOADS_PER_SYNC),
            });
          }
          continue;
        }
        uploadCount += 1;
        if (!options.activationProbe) options.transferAdmission?.record(attachment, 'upload');
        let snapshot: Awaited<ReturnType<typeof common.createMobileAttachmentUploadSnapshot>> = null;
        try {
          assertDropboxNotAborted(options.signal);
          snapshot = await common.createMobileAttachmentUploadSnapshotWithLimit(uri, attachment, plaintextLimit);
          if (!snapshot) continue;
          if (
            attachment.pendingContentUpload === true
            && snapshot.fileHash !== attachment.fileHash?.trim().toLowerCase()
          ) {
            continue;
          }
          const fileSize = snapshot.stat.size;

          const validation = await validateAttachmentForUpload(attachment, fileSize);
          if (!validation.valid) {
            files.logAttachmentWarn(`Attachment validation failed (${validation.error}) for ${attachment.id}`);
            continue;
          }
          const totalBytes = Math.max(0, Number(fileSize ?? 0));
          reportProgress(attachment.id, 'upload', 0, totalBytes, 'active');

          const cloudKey = buildCloudKey(attachment);
          const readResult = await files.readAttachmentBytesForUpload(snapshot.sourcePath);
          if (readResult.readFailed) throw readResult.error;
          const uploadBytes = readResult.data;
          if (plaintextLimit !== undefined) assertBufferedAttachmentUploadSize(uploadBytes.byteLength, plaintextLimit);
          const wireBytes = await common.sealAttachmentBytesForUpload(uploadBytes, options.material, cloudKey);
          if (maxDropboxBufferedUploadBytes !== undefined) assertBufferedAttachmentUploadSize(wireBytes.byteLength, maxDropboxBufferedUploadBytes);
          const expectedRev = await files.runDropboxAuthorized(
            dropboxClientId,
            (accessToken) => core.getDropboxFileMetadata(
              accessToken,
              cloudKey,
              fetcher,
              { signal: options.signal },
            ),
            fetcher,
            options.resolveAccessToken,
          ).then((metadata) => metadata.rev);
          await files.runDropboxAuthorized(
            dropboxClientId,
            async (accessToken) => {
              await options.assertRemoteMutationFenceHeld?.(35_000);
              return core.uploadDropboxFileVersioned(
                accessToken,
                cloudKey,
                toAttachmentArrayBuffer(wireBytes),
                expectedRev,
                fetcher,
                { signal: options.signal },
              );
            },
            fetcher,
            options.resolveAccessToken,
          );

          assertDropboxNotAborted(options.signal);
          pendingUploadMutations.push({
            attachment,
            cloudKey,
            fileHash: snapshot.fileHash,
            stat: snapshot.stat,
            fileSize: Number.isFinite(fileSize ?? NaN) ? Number(fileSize) : undefined,
            totalBytes,
          });
        } catch (error) {
          if (isAbortLikeError(error, options.signal) || maxDropboxBufferedUploadBytes !== undefined && isAttachmentUploadAdmissionError(error)) {
            throw error;
          }
          if (isSyncRemoteMutationFenceError(error) || core.isDropboxConflictError(error)) {
            throw error;
          }
          reportProgress(
            attachment.id,
            'upload',
            0,
            attachment.size ?? 0,
            'failed',
            error instanceof Error ? error.message : String(error)
          );
          files.logAttachmentWarn(`Failed to upload attachment ${attachment.id}`, error);
        } finally {
          if (snapshot) {
            await snapshot.dispose().catch((error) => {
              files.logAttachmentWarn(`Failed to clean up attachment upload snapshot ${attachment.id}`, error);
            });
          }
        }
      }

      if (
        options.phase !== 'prepare'
        && attachment.cloudKey
        && !existsLocally
        && !isContent
        && !isHttp
      ) {
        if (attachment.pendingContentUpload !== true) {
          downloadQueue.push({ attachment, expectation: { kind: 'absent' }, recoverPendingUpload: false });
        } else if (isSha256Hex(attachment.fileHash?.trim().toLowerCase())) {
          downloadQueue.push({ attachment, expectation: { kind: 'absent' }, recoverPendingUpload: true });
        }
      }
    }

    for (const pending of pendingUploadMutations) {
      pending.attachment.cloudKey = pending.cloudKey;
      pending.attachment.pendingContentUpload = undefined;
      applyAttachmentContentStat(pending.attachment, pending.stat, pending.fileHash);
      if (!Number.isFinite(pending.attachment.size ?? NaN) && Number.isFinite(pending.fileSize ?? NaN)) {
        pending.attachment.size = Number(pending.fileSize);
      }
      pending.attachment.localStatus = 'available';
      recordPatch(pending.attachment);
      reportProgress(pending.attachment.id, 'upload', pending.totalBytes, pending.totalBytes, 'completed');
    }

    if (!attachmentsDir) return foldPatches();

    let downloadCount = 0;
    for (const { attachment, expectation, recoverPendingUpload } of downloadQueue) {
      if (attachment.kind !== 'file') continue;
      if (attachment.deletedAt) continue;
      if (!attachment.cloudKey) continue;
      if (
        !options.activationProbe
        && expectation.kind === 'absent'
        && !recoverPendingUpload
        && await adoptVerifiedDownloadTarget(attachment, `${attachmentsDir}${downloadFilename(attachment)}`)
      ) {
        await common.refreshBespokeAttachmentDownloadedContentStat(attachment, attachment.uri!);
        recordPatch(attachment);
        continue;
      }
      if (!options.activationProbe && options.transferAdmission?.has(attachment, 'download')) continue;

      if (!options.activationProbe && files.getWebdavDownloadBackoff(attachment.id)) continue;
      if (!options.activationProbe && downloadCount >= DROPBOX_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC) {
        files.logAttachmentInfo('Dropbox attachment download limit reached', {
          limit: String(DROPBOX_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC),
        });
        break;
      }
      downloadCount += 1;
      if (!options.activationProbe) options.transferAdmission?.record(attachment, 'download');

      const cloudKey = attachment.cloudKey;
      try {
        assertDropboxNotAborted(options.signal);
        reportProgress(attachment.id, 'download', 0, attachment.size ?? 0, 'active');
        const data = await files.runDropboxAuthorized(
          dropboxClientId,
          (accessToken) => core.downloadDropboxFile(
            accessToken,
            cloudKey,
            fetcher,
            { signal: options.signal },
          ),
          fetcher,
          options.resolveAccessToken,
        );


        const bytes = await common.openAttachmentBytesFromDownload(
          data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer),
          options.material,
          cloudKey,
        );
        await validateAttachmentHash(attachment, bytes);
        const targetUri = resolveAttachmentDownloadTargetPath(
          attachment,
          `${attachmentsDir}${downloadFilename(attachment)}`,
          expectation,
        );
        assertDropboxNotAborted(options.signal);
        const installed = await common.installAttachmentDownloadBytes(
          attachment,
          attachmentsDir,
          targetUri,
          bytes,
          expectation,
          options.signal,
        );
        if (!installed) {
          files.logAttachmentWarn(`Skipped remote attachment replacement after a native conflict (${attachment.id})`);
          continue;
        }
        if (recoverPendingUpload && attachment.pendingContentUpload === true) {
          attachment.pendingContentUpload = undefined;
        }
        attachment.uri = targetUri;
        attachment.localStatus = 'available';
        if (!options.activationProbe) files.clearWebdavDownloadBackoff(attachment.id);
        await common.refreshBespokeAttachmentDownloadedContentStat(attachment, targetUri);
        recordPatch(attachment);
        reportProgress(attachment.id, 'download', bytes.length, bytes.length, 'completed');
      } catch (error) {
        if (isAbortLikeError(error, options.signal)) {
          throw error;
        }
        if (
          expectation.kind === 'absent'
          && core.isDropboxFileNotFoundError(error)
          && attachment.cloudKey
        ) {
          if (!options.activationProbe) {
            files.setWebdavDownloadBackoff(attachment.id, { status: 404 });
            files.logAttachmentInfo('Dropbox attachment not found; row kept', {
              id: attachment.id,
              releaseCheck: 'v1.3.8/attachment-not-found-kept',
            });
          }
          if (!recoverPendingUpload && handleRemoteAttachmentNotFound(attachment, options.activationProbe === true)) {
            recordPatch(attachment);
          }
        }
        if (
          expectation.kind === 'absent'
          && !core.isDropboxFileNotFoundError(error)
          && attachment.localStatus !== 'missing'
        ) {
          attachment.localStatus = 'missing';
          recordPatch(attachment);
        }
        reportProgress(
          attachment.id,
          'download',
          0,
          attachment.size ?? 0,
          'failed',
          error instanceof Error ? error.message : String(error)
        );
        files.logAttachmentWarn(`Failed to download attachment ${attachment.id}`, error);
      }
    }


    if (reconcilePresence && presenceProven && !options.activationProbe) {
      await files.markAttachmentPresenceReconciled();
    }

    return foldPatches();
  };

  const syncDropboxAttachments = async (...args: Parameters<typeof runDropboxAttachmentPass>): Promise<AppData | false> => {
    try { return await runDropboxAttachmentPass(...args); }
    catch (error) {
      if (maxDropboxBufferedUploadBytes !== undefined && isAttachmentUploadAdmissionError(error)) {
        try { files.logAttachmentWarn('Dropbox host upload admission refused', undefined, {
          releaseCheck: 'v1.3.9/ios-dropbox', operation: 'attachment-upload', outcome: 'refused',
        }); } catch { }
        throw new Error('Dropbox attachment upload cannot be admitted by this host transport');
      }
      throw error;
    }
  };

  const syncFileAttachments = async (
    appData: AppData,
    syncPath: string,
    signal?: AbortSignal,
    options: {
      activationProbe?: boolean;
      phase?: 'prepare' | 'post-merge';

      material?: SyncKeyMaterial | null;

      transferAdmission?: AttachmentTransferAdmission;
    } = {}
  ): Promise<AppData | false> => {
    class FileSyncGenerationIntegrityError extends Error {
      constructor(message: string, options?: { cause?: unknown }) {
        super(message);
        this.name = 'FileSyncGenerationIntegrityError';
        if (options) (this as Error & { cause?: unknown }).cause = options.cause;
      }
    }

    assertAttachmentSyncNotAborted(signal);
    await common.assertEncryptionPosture(options.material);
    const syncDir = await files.resolveFileSyncDir(syncPath);
    if (!syncDir) return false;


    if (syncDir.type === 'file') {
      await installer.recoverFileSyncAttachmentPublications(syncDir.attachmentsDirUri);
    }

    assertAttachmentSyncNotAborted(signal);
    const attachmentsDir = await files.getAttachmentsDir();
    if (!attachmentsDir) return false;

    const attachmentsById = collectAttachmentsById(appData);
    const computeManagedAttachmentFileHash = async (path: string): Promise<string | null> => {
      try {
        return (await installer.hashAttachmentFileGeneration(path)).sha256;
      } catch (error) {
        files.logAttachmentWarn('Failed to hash managed attachment file natively', error);
        return null;
      }
    };


    let safEntriesByName: Map<string, string> | null = null;

    let safEntrySizes = new Map<string, number | null>();
    let safEntryDirectories = new Set<string>();
    const refreshSafEntriesByName = async (): Promise<Map<string, string>> => {
      const inventory = await files.inspectSafDirectoryEntriesByName(syncDir.attachmentsDirUri);
      if (inventory.status === 'unreadable') {
        throw new Error('SAF attachment inventory is unreadable');
      }
      safEntriesByName = inventory.entries;
      safEntrySizes = inventory.sizes;
      safEntryDirectories = inventory.directories;
      return inventory.entries;
    };
    const getSafEntriesByName = async (): Promise<Map<string, string>> => (
      safEntriesByName ?? refreshSafEntriesByName()
    );


    type ListedEntry = { uri: string; size: () => Promise<number | null>; directory: () => Promise<boolean> };
    const statPathEntry = (uri: string) => fs.getInfo(uri).catch((): { exists?: boolean; isDirectory?: boolean; size?: number } => ({}));
    const listFolder = async (dirUri: string, top: boolean): Promise<Map<string, ListedEntry>> => {
      const listed = new Map<string, ListedEntry>();
      if (syncDir.type === 'saf') {
        const inventory = top ? null : await files.inspectSafDirectoryEntriesByName(dirUri);
        if (inventory?.status === 'unreadable') return listed;
        const entries = top ? await getSafEntriesByName() : inventory!.status === 'available' ? inventory!.entries : new Map<string, string>();
        const sizes = top ? safEntrySizes : inventory?.status === 'available' ? inventory.sizes : new Map<string, number | null>();
        const folders = top ? safEntryDirectories : inventory?.status === 'available' ? inventory.directories : new Set<string>();
        for (const [name, uri] of entries) {
          listed.set(name, { uri, size: async () => sizes.get(name) ?? null, directory: async () => folders.has(name) });
        }
      } else {
        const base = dirUri.endsWith('/') ? dirUri : `${dirUri}/`;
        for (const name of await fs.readDirectory(base)) {
          const uri = `${base}${name}`;
          listed.set(name, {
            uri,
            size: async () => { const info = await statPathEntry(uri); return info.exists && typeof info.size === 'number' ? info.size : null; },
            directory: async () => (await statPathEntry(uri)).isDirectory === true,
          });
        }
      }
      return listed;
    };
    const isRecoveryFolderName = (name: string) => (
      name.startsWith('.mindwtr-encryption-stage-') || name.startsWith('.mindwtr-encryption-quarantine-')
    );
    const isTransitionScratch = (name: string) => name.includes('.mindwtr-et-') || name.endsWith('.enctransition');


    const isNotAttachment = (name: string) => name === '.mindwtr-attachment-installer.lock' || isTransitionScratch(name) || isRecoveryFolderName(name);

    const isEntryGoneError = (error: unknown): boolean => {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code.toUpperCase() : '';
      if (code === 'ENOENT' || code === 'ERR_FILE_NOT_FOUND') return true;
      return /\bENOENT\b|no such file or directory|FileNotFoundException|missing file/i.test(error instanceof Error ? error.message : String(error ?? ''));
    };
    const sortedNames = (listed: Map<string, ListedEntry>) => [...listed.keys()].sort(compareSyncTransitionEntryNames);
    let folderProvenPlaintext = false;
    const assertFolderHoldsNoCiphertext = async (): Promise<void> => {
      if (options.material || folderProvenPlaintext) return;
      const top = await listFolder(syncDir.attachmentsDirUri, true);
      const plaintextSizes = new Map<string, number | null>();
      for (const item of [...appData.tasks, ...appData.projects]) {
        for (const attachment of item.attachments ?? []) {
          if (attachment.kind !== 'file' || !attachment.cloudKey) continue;
          plaintextSizes.set(remoteFilenameFor(attachment.cloudKey, attachment), typeof attachment.size === 'number' ? attachment.size : null);
        }
      }
      const coreOrder = sortedNames(top).filter((name) => !isNotAttachment(name));
      const judged = new Map<string, ListedEntry>();
      for (const name of [coreOrder[0], coreOrder[coreOrder.length - 1], ...coreOrder.filter((each) => plaintextSizes.has(each))]) {
        if (name !== undefined) judged.set(name, top.get(name)!);
      }

      let folder = top;
      let prefix = '';
      for (let depth = 0; depth < 8; depth += 1) {
        const first = sortedNames(folder).find((name) => !isNotAttachment(name));
        if (first === undefined) break;
        const entry = folder.get(first)!;
        if (!(await entry.directory())) {
          judged.set(`${prefix}${first}`, entry);
          break;
        }
        folder = await listFolder(entry.uri, false);
        prefix = `${prefix}${first}/`;
      }
      for (const [name, entry] of judged) {
        assertAttachmentSyncNotAborted(signal);
        const plaintextSize = plaintextSizes.get(name);
        if (typeof plaintextSize === 'number' && await entry.size() === plaintextSize) continue;

        if (await entry.directory()) continue;

        const head = await fs.readBytesRange(entry.uri, 0, 64).catch((error: unknown) => {
          if (isEntryGoneError(error)) return null;
          throw error;
        });
        if (!head || inspectSyncArtifact(head).kind === 'plaintext') continue;
        files.logAttachmentWarn('File Sync attachment upload refused: the folder holds encrypted attachments', undefined, {
          releaseCheck: 'v1.3.8/file-partly-encrypted-upload',
        });
        throw new SyncEncryptionPartlyEncryptedError();
      }
      folderProvenPlaintext = true;
    };
    const remoteFilenameFor = (cloudKey: string, attachment: { id: string; title: string }): string =>
      cloudKey.split('/').pop() || `${attachment.id}${extractExtension(attachment.title)}`;


    const reconcilePresence = options.activationProbe || await files.isAttachmentPresenceReconciliationDue();
    const migrateAttachmentLocally = files.createAttachmentLocalMigrationLimiter();


    const allPatches = new Map<string, Attachment>();
    for (const original of attachmentsById.values()) {
      assertAttachmentSyncNotAborted(signal);
      if (original.kind !== 'file' || original.deletedAt) continue;
      const attachment: Attachment = { ...original };
      let patched = false;
      if (files.attachmentNeedsManagedLocalCopy(attachment)) {
        const sourcePresence = await files.getLocalAttachmentPresence(attachment.uri || '');
        if (sourcePresence === 'unreadable') {
          attachmentsById.delete(attachment.id);
          continue;
        }
        if (sourcePresence === 'present') {
          const localMigration = await migrateAttachmentLocally(attachment);
          if (localMigration.migrated) patched = true;
          if (localMigration.skipped) {
            attachmentsById.delete(attachment.id);
            continue;
          }
        }
      }

      const uri = attachment.uri || '';
      const isHttp = isHttpAttachmentUri(uri);
      const hasLocal = Boolean(uri) && !isHttp;
      const localPresence = hasLocal
        ? await files.getLocalAttachmentPresence(uri)
        : 'confirmed-not-found';
      if (localPresence === 'unreadable') {
        attachmentsById.delete(attachment.id);
        continue;
      }
      if (reconcilePresence && localPresence === 'present' && attachment.pendingContentUpload !== true) {
        const cloudKey = attachment.cloudKey || buildCloudKey(attachment);
        const filename = remoteFilenameFor(cloudKey, attachment);
        const remotePresence = syncDir.type === 'file'
          ? await files.getLocalAttachmentPresence(`${syncDir.attachmentsDirUri}${filename}`)
          : (await getSafEntriesByName()).has(filename) ? 'present' : 'confirmed-not-found';
        if (remotePresence === 'confirmed-not-found' && attachment.cloudKey !== undefined) {
          attachment.cloudKey = undefined;
          patched = true;
        }
      }

      if (patched) {
        allPatches.set(attachment.id, attachment);
        attachmentsById.set(attachment.id, attachment);
      }
    }

    if (reconcilePresence && !options.activationProbe) {
      await files.markAttachmentPresenceReconciled();
    }

    const { patches } = await common.runMobileAttachmentLifecycle({
      attachmentsById,
      getLocalFilePresence: files.getLocalAttachmentPresence,
      deferUploads: options.phase === 'prepare',
      admission: options.activationProbe ? undefined : options.transferAdmission,
      getLocalFileStat: (path) => files.statAttachmentFile(path),
      computeLocalFileHash: (path) => computeManagedAttachmentFileHash(path),
      maxBufferedUploadBytes: core.maxFileSyncBufferedPlaintextBytes(),
      contentChangePhase: options.phase,
      isFatalError: (error) => (
        isAttachmentSyncAbortError(error, signal)
        || isAttachmentUploadAdmissionError(error)
        || isSyncEncryptionPartlyEncryptedError(error)
      ),


      onDownload: async (attachment, expectation) => {
        if (!attachment.cloudKey) return false;
        const filename = remoteFilenameFor(attachment.cloudKey, attachment);
        const remoteUri = syncDir.type === 'file'
          ? `${syncDir.attachmentsDirUri}${filename}`
          : (await getSafEntriesByName()).get(filename) ?? null;
        const remotePresence = syncDir.type === 'saf'
          ? remoteUri ? 'present' : 'confirmed-not-found'
          : remoteUri
            ? await files.getLocalAttachmentPresence(remoteUri)
            : 'confirmed-not-found';
        if (remotePresence === 'unreadable') {
          throw new Error('Attachment remote presence is unreadable');
        }
        const remoteExists = remotePresence === 'present';
        if (
          (attachment.pendingContentUpload === true || expectation.kind === 'present'
            || (host.eagerFileSyncDownloads === true && !options.activationProbe))
          && remoteUri
          && remoteExists
        ) {
          let stagedPath: string | null = null;
          let installHelperOwnsStage = false;
          try {
            assertAttachmentSyncNotAborted(signal);
            stagedPath = await common.copyAttachmentDownloadToStage(attachment, attachmentsDir, remoteUri);
            let expectedStagedHash = !options.material && isSha256Hex(attachment.fileHash)
              ? attachment.fileHash.toLowerCase()
              : null;
            let downloadedSize: number | null = null;
            if (!expectedStagedHash) {
              const wireBytes = await common.readAttachmentDownloadStageBytes(stagedPath);
              const plaintextBytes = await common.openAttachmentBytesFromDownload(wireBytes, options.material, attachment.cloudKey);
              const plaintextHash = await computeSha256Hex(plaintextBytes);
              if (!plaintextHash) throw new Error('Attachment download hash is unavailable');
              await validateAttachmentHash(attachment, plaintextBytes);
              if (plaintextBytes !== wireBytes) {
                await files.writeBytesSafely(stagedPath, plaintextBytes);
              }
              expectedStagedHash = plaintextHash;
              downloadedSize = plaintextBytes.byteLength;
            } else if (!Number.isFinite(attachment.size ?? NaN)) {
              const stagedInfo = await fs.getInfo(stagedPath);
              downloadedSize = stagedInfo.exists && typeof stagedInfo.size === 'number'
                ? stagedInfo.size
                : null;
            }
            assertAttachmentSyncNotAborted(signal);
            const targetUri = resolveAttachmentDownloadTargetPath(
              attachment,
              `${attachmentsDir}${filename}`,
              expectation,
            );
            installHelperOwnsStage = true;
            const installed = await common.installStagedAttachmentDownload({
              attachment,
              stagedPath,
              targetPath: targetUri,
              expectation,
              signal,
              expectedStagedHash,
            });
            if (!installed) return false;
            attachment.uri = targetUri;
            attachment.localStatus = 'available';
            if (!Number.isFinite(attachment.size ?? NaN) && downloadedSize != null) {
              attachment.size = downloadedSize;
            }
            return true;
          } catch (error) {
            if (stagedPath && !installHelperOwnsStage) {
              await common.deleteAttachmentDownloadStageBestEffort(stagedPath);
            }
            throw error;
          }
        }
        if (!options.activationProbe) return false;
        if (!remoteExists) {


          files.logAttachmentWarn('File Sync activation left an attachment the folder does not hold yet', undefined, {
            releaseCheck: 'v1.3.0/mobile-file-activation-absent-blob',
          });
          return false;
        }
        attachment.localStatus = 'available';
        return true;
      },
      onDownloadError: () => {},
      onUpload: async (attachment, localPath, snapshot) => {
        if (!snapshot) throw new Error('Immutable attachment upload snapshot is unavailable');
        await assertFolderHoldsNoCiphertext();
        const cloudKey = buildFileSyncGenerationCloudKey(attachment, snapshot.fileHash);
        const recordPublishedGeneration = (): void => {
          attachment.cloudKey = cloudKey;
        };
        const filename = remoteFilenameFor(cloudKey, attachment);
        const size = await files.getAttachmentByteSize(attachment, localPath);
        if (size != null) {
          const validation = await validateAttachmentForUpload(attachment, size, FILE_BACKEND_VALIDATION_CONFIG);
          if (!validation.valid) {
            files.logAttachmentWarn(`Attachment validation failed (${validation.error}) for ${attachment.id}`);
            return false;
          }
        }
        const material = options.material ?? null;
        const verifyPublishedGeneration = async (targetUri: string): Promise<void> => {
          const wireBytes = await files.readFileAsBytes(targetUri);
          try {
            const plaintextBytes = await common.openAttachmentBytesFromDownload(wireBytes, material, cloudKey);
            const actualHash = await computeSha256Hex(plaintextBytes);
            if (actualHash?.toLowerCase() !== snapshot.fileHash.toLowerCase()) {
              throw new Error('plaintext digest mismatch');
            }
          } catch (error) {
            throw new FileSyncGenerationIntegrityError(
              'File Sync attachment generation failed integrity verification',
              { cause: error },
            );
          }
        };
        const wireBytes = await common.sealAttachmentBytesForUpload(await files.readFileAsBytes(localPath), material, cloudKey);
        if (syncDir.type === 'file') {
          const targetUri = `${syncDir.attachmentsDirUri}${filename}`;
          const wireHash = await computeSha256Hex(wireBytes);
          if (!wireHash) throw new Error('File Sync attachment stage could not be hashed');
          const initialPresence = await files.getLocalAttachmentPresence(targetUri);
          if (initialPresence === 'unreadable') {
            throw new Error('File Sync attachment generation is unreadable');
          }
          if (initialPresence === 'confirmed-not-found') {


            await installer.clearFileSyncAttachmentPublicationRecovery(targetUri);
          }
          if (initialPresence === 'present') {
            try {
              await verifyPublishedGeneration(targetUri);
              await installer.clearFileSyncAttachmentPublicationRecovery(targetUri);
              recordPublishedGeneration();
              return true;
            } catch (error) {
              if (!(error instanceof FileSyncGenerationIntegrityError)) throw error;
            }
          }

          const reservation = await installer.reserveFileSyncAttachmentPublication(targetUri, wireHash);
          const stagedUri = reservation.stagedPath;
          try {
            assertAttachmentSyncNotAborted(signal);
            await fs.writeBytes(stagedUri, wireBytes);
            await verifyPublishedGeneration(stagedUri);
            await installer.claimFileSyncAttachmentPublication(reservation);
          } catch (error) {
            await installer.abandonFileSyncAttachmentPublication(reservation).catch(() => undefined);
            throw error;
          }


          const currentPresence = await files.getLocalAttachmentPresence(targetUri);
          if (currentPresence === 'unreadable') {
            throw new Error('File Sync attachment generation is unreadable');
          }
          if (currentPresence === 'present') {
            try {
              await verifyPublishedGeneration(targetUri);
              await installer.completeFileSyncAttachmentPublication(reservation);
              recordPublishedGeneration();
              return true;
            } catch (error) {
              if (!(error instanceof FileSyncGenerationIntegrityError)) throw error;
            }
          }

          assertAttachmentSyncNotAborted(signal);
          const publication = await installer.publishImmutableAttachmentFileGeneration(
            stagedUri,
            targetUri,
            wireHash,
          );
          if (publication.status === 'alreadyExists') {
            try {
              await verifyPublishedGeneration(targetUri);
            } catch (error) {
              if (error instanceof FileSyncGenerationIntegrityError) {
                await installer.retainFileSyncAttachmentPublicationForInvalidTarget(reservation);
              }
              throw error;
            }
          }
          try {
            await verifyPublishedGeneration(targetUri);
          } catch (error) {
            if (error instanceof FileSyncGenerationIntegrityError) {
              await installer.retainFileSyncAttachmentPublicationForInvalidTarget(reservation);
            }
            throw error;
          }
          await installer.completeFileSyncAttachmentPublication(reservation);
        } else {
          assertAttachmentSyncNotAborted(signal);
          const safEntries = await getSafEntriesByName();
          let targetUri = safEntries.get(filename) ?? null;
          if (targetUri) {
            await verifyPublishedGeneration(targetUri);
            recordPublishedGeneration();
            return true;
          }
          let invocationOwnedTarget: string | null = null;
          const saf = fs.saf();
          if (!saf?.createFile || !saf?.writeBytes) {
            throw new Error('SAF attachment writes are unavailable');
          }
          try {
            assertAttachmentSyncNotAborted(signal);
            try {
              targetUri = await saf.createFile(
                syncDir.attachmentsDirUri,
                filename,
                attachment.mimeType || DEFAULT_ATTACHMENT_CONTENT_TYPE
              );
            } catch (createError) {
              const peerTarget = (await refreshSafEntriesByName()).get(filename) ?? null;
              if (peerTarget) {
                await verifyPublishedGeneration(peerTarget);
                recordPublishedGeneration();
                return true;
              }
              throw createError;
            }
            if (!targetUri) throw new Error('SAF attachment target creation failed');
            invocationOwnedTarget = targetUri;
            if (await getSafDocumentName(saf, targetUri) !== filename) {
              await fs.delete(targetUri).catch(() => undefined);
              invocationOwnedTarget = null;
              const peerTarget = (await refreshSafEntriesByName()).get(filename) ?? null;
              if (peerTarget) {
                await verifyPublishedGeneration(peerTarget);
                recordPublishedGeneration();
                return true;
              }
              throw new Error('SAF provider did not create the requested attachment name');
            }
            assertAttachmentSyncNotAborted(signal);
            await saf.writeBytes(targetUri, wireBytes);
            await verifyPublishedGeneration(targetUri);
            safEntries.set(filename, targetUri);
            invocationOwnedTarget = null;
          } catch (error) {
            if (invocationOwnedTarget) {
              await fs.delete(invocationOwnedTarget).catch(() => undefined);
            }
            throw error;
          }
        }
        recordPublishedGeneration();


        return true;
      },
      onUploadError: (attachment, error) => {
        files.logAttachmentWarn(`Failed to copy attachment ${attachment.id} to sync folder`, error);
      },
    });

    for (const patch of patches.values()) allPatches.set(patch.id, patch);
    const nextData = applyAttachmentPatches(appData, allPatches);
    return nextData !== appData ? nextData : false;
  };

  return {
    syncWebdavAttachments,
    syncCloudAttachments,
    syncDropboxAttachments,
    syncFileAttachments,
  };
};

export type MobileAttachmentBackends = ReturnType<typeof createMobileAttachmentBackends>;
