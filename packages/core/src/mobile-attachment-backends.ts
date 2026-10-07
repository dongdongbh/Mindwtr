// The mobile attachment sync passes, one per remote: WebDAV, the self-hosted cloud, Dropbox and
// File Sync. Each walks the document's file attachments, uploads local bytes the remote lacks,
// downloads remote bytes the device lacks and returns the folded document (or `false` when
// nothing changed). They moved here from React Native's
// `apps/mobile/lib/attachment-sync-backends/{webdav,cloud,dropbox,file}.ts` so the native apps
// run the same rules; each host binds them to its file IO, native installer and transports.
//
// Data safety: bytes are uploaded before `cloudKey` is recorded, and the metadata is published
// only after that. A remote 404 is terminal (the attachment is marked unrecoverable), a failed
// download never deletes local bytes, `pendingContentUpload` survives until the edited bytes
// are on the remote, and a new WebDAV upload is sent with `If-None-Match: *`.
import type { AppData, Attachment } from './types';
import { applyAttachmentContentStat, type LocalFileStat } from './attachment-change-detection';
import { computeSha256Hex, isSha256Hex } from './attachment-hash';
import { ATTACHMENTS_DIR_NAME, buildCloudKey, buildFileSyncGenerationCloudKey, extractExtension } from './attachment-paths';
import { isAttachmentPresenceRepairCandidate, repairMissingRemoteAttachments } from './attachment-presence-repair';
import {
  applyAttachmentPatches,
  collectAttachmentsById,
  assertBufferedAttachmentUploadSize,
  isAttachmentUploadAdmissionError,
  MAX_FILE_SYNC_BUFFERED_PLAINTEXT_BYTES,
  reportProgress,
  validateAttachmentHash,
  WebdavHostUploadLimitError,
  type AttachmentDownloadExpectation,
} from './attachment-transfer';
import { markAttachmentUnrecoverable, validateAttachmentForUpload } from './attachment-validation';
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
import { encryptedSyncArtifactByteLength, type SyncKeyMaterial } from './sync-crypto';
import { isSyncRemoteMutationFenceError } from './sync-remote-fence';
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
  getSafLeafName,
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

/** Core functions called through here so a host's tests can replace them the way they
 *  replace `@mindwtr/core`. A host that passes nothing gets core's own. */
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
  /** The largest File Sync attachment the pass reads into memory to seal. */
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
  /** Only File Sync uses it: scratch stats, stage writes and SAF creates. */
  fs: MobileAttachmentFileSystemPort;
  files: MobileAttachmentFiles;
  common: MobileAttachmentCommon;
  /** File Sync's native hash and its immutable, journaled publication. */
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
  /** Optional wire-byte admission for a host's buffered WebDAV transport.
   * Each pass reserves encryption-envelope bytes when material is present. */
  maxWebdavBufferedUploadBytes?: number;
  core?: Partial<MobileAttachmentBackendsCoreFunctions>;
};

export type CloudAttachmentSyncOptions = {
  activationProbe?: boolean;
  assertCurrent?: () => void;
  assertRemoteMutationFenceHeld?: (minRemainingMs?: number) => Promise<void>;
  phase?: 'prepare' | 'post-merge';
  signal?: AbortSignal;
};

export type DropboxAttachmentSyncOptions = {
  activationProbe?: boolean;
  phase?: 'prepare' | 'post-merge';
  resolveAccessToken?: DropboxAccessTokenResolver;
  signal?: AbortSignal;
  assertRemoteMutationFenceHeld?: (minRemainingMs?: number) => Promise<void>;
  /** #1056: seal bytes before upload / open them after download. Null = encryption off. */
  material?: SyncKeyMaterial | null;
};

const CLOUD_REMOTE_MUTATION_REQUEST_HORIZON_MS = 35_000;

// Thrown only for a local file that has become unreadable (e.g. a revoked SAF permission).
// Caught inside `onUpload`'s own catch below so `markAttachmentUnrecoverable`'s mutation is
// tracked via onUpload's return value — mutations from `onUploadError` are NOT seen by the
// shared lifecycle's own `didMutate` tracking, only onUpload/onDownload return values are.
class LocalReadFailure extends Error {
  constructor(public readonly cause: unknown) {
    super('Attachment local file is unreadable');
  }
}

/** An upload the self-hosted cloud or Dropbox accepted; its metadata is published only after
 *  the loop, so a later throw in the pass records nothing. */
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
  const maxWebdavBufferedUploadBytes = host.maxWebdavBufferedUploadBytes;
  if (maxWebdavBufferedUploadBytes !== undefined
    && (!Number.isSafeInteger(maxWebdavBufferedUploadBytes) || maxWebdavBufferedUploadBytes <= 0)) {
    throw new Error('WebDAV buffered upload capability is invalid');
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
      /** #1056: seal bytes before upload / open them after download. Null = encryption off. */
      material?: SyncKeyMaterial | null;
      assertRemoteMutationFenceHeld?: (minRemainingMs?: number) => Promise<void>;
      onTransferBatchDeferred?: () => void;
    } = {}
  ): Promise<AppData | false> => {
    assertAttachmentSyncNotAborted(signal);
    const material = options.material ?? null;
    const maxBufferedPlaintextBytes = maxWebdavBufferedUploadBytes === undefined
      ? undefined
      : Math.max(0, maxWebdavBufferedUploadBytes - (material ? encryptedSyncArtifactByteLength(0) : 0));
    const assertUploadStat = maxBufferedPlaintextBytes === undefined ? undefined : (stat: LocalFileStat | null) => {
      // Validate the source size before computing its encrypted length. Clamping the
      // plaintext cap to zero keeps existing validators valid even when the wire cap
      // cannot hold an empty envelope; the second check refuses that case on demand.
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
    // Stays unconditional and outside the try below: it makes no request, and a refused
    // connection is not a "directory already exists" failure to shrug off — swallowing it
    // let the whole insecure pass continue (SEC-10a).
    assertMobileWebdavConnection(attachmentsDirUrl, webDavConfig.allowInsecureHttp);
    // Only a PUT needs the collection to exist; HEAD and GET do not. This used to run on
    // every pass, which cost one MKCOL per idle cycle for anyone with a synced attachment
    // (audit F3), so it is now deferred to just before the first upload of a pass.
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
      // Set only once the call did not throw a fatal error, so a fence loss that aborts
      // this upload does not silently skip the MKCOL for a later retry.
      attachmentsDirEnsured = true;
    };

    const attachmentsDir = await files.getAttachmentsDir();
    if (!attachmentsDir) return false;
    const attachmentsById = collectAttachmentsById(appData);

    files.pruneWebdavDownloadBackoff();
    // See `isAttachmentPresenceReconciliationDue`: an uploaded attachment's key is derived
    // from its id and its bytes never change, so the presence pass below can only ever
    // discover a server-side deletion — worth proving daily, not hourly (audit F3). An
    // activation probe is different: it has to prove the candidate backend holds every object
    // right now. Later batches in that same guarded trial retain the earlier proof,
    // avoiding repeated HEADs. A separate activation always reconciles and never stamps.
    const reconcilePresence = options.activationProbe
      ? options.activationContinuation !== true
      : await files.isAttachmentPresenceReconciliationDue();
    files.logAttachmentInfo('WebDAV attachment sync start', {
      count: String(attachmentsById.size),
      presence: reconcilePresence ? 'reconcile' : 'skipped',
    });

    // Every pass writes only to per-attachment copies and records them here; the patches are
    // folded into a fresh document at the end. `attachmentsById` is updated alongside so a
    // later pass reads the earlier pass's values.
    const allPatches = await common.migrateAttachmentsLocallyBeforeSync(
      attachmentsById, signal, maxBufferedPlaintextBytes, assertUploadStat,
    );

    let abortedByRateLimit = false;
    const presenceCandidates: Attachment[] = [];

    // Preserve mobile's existing gated local prepass, then pass only readable, eligible
    // attachments to the shared tri-state remote proof below.
    for (const attachment of attachmentsById.values()) {
      if (!reconcilePresence) break;
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

      if (existsLocally) {
        files.clearWebdavDownloadBackoff(attachment.id);
      }

      if (hasLocalPath && existsLocally && !isHttp && isAttachmentPresenceRepairCandidate(attachment)) {
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
          files.clearWebdavDownloadBackoff(attachment.id);
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

    // Throttle policy: per-run upload/download caps, plus the same rate-limit abort the pre-pass
    // above already tripped. Passed to the shared lifecycle as optional `policy` hooks.
    let uploadCount = 0;
    let uploadLimitLogged = false;
    let downloadCount = 0;
    let downloadLimitLogged = false;

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
      // The backoff is keyed by attachment id, not by destination, so it is stale
      // for the candidate backend an activation probe has to prove right now. A
      // deferred download would leave the attachment `unproven` and fail activation
      // (core sync-run `classifyActivationAttachmentProof` allows `deferred` only
      // for the file backend).
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
            throw new Error('WebDAV attachment version is unavailable; refusing an unconditional overwrite');
          }
          files.logAttachmentInfo('WebDAV attachment upload start', {
            id: attachment.id,
            bytes: String(uploadBytes),
            cloudKey,
          });
          // The FileSystem uploader streams the LOCAL file straight to the server, so it
          // can only ever send plaintext. With encryption on we must go through the
          // read-seal-PUT path below instead.
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
          // The native uploader follows a redirect by itself: a 307 or 308 stores the file at
          // another URL and a 303 stores nothing, yet the task answers 2xx. Record the cloud
          // key only once a HEAD at this URL, not after a redirect, finds the file (with the
          // uploaded size when it states one).
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
              // A redirected HEAD (a download CDN, or a write redirect) proves nothing about this
              // URL, so the bytes go once more through the buffered PUT, whose redirect core
              // refuses. An attachment is never left unsynced for good by an unprovable stream.
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
              // After a stream this PUT is create-only, and the HEAD before the stream found no
              // file here. A 412 now says some file exists, not that it holds these bytes (another
              // writer may have created it), so it is recorded only when the same HEAD proof finds
              // it; otherwise it stays unsynced and the next sync sends it as an overwrite.
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
          // localStatus is already 'available' here: onUpload only runs when the lifecycle's own
          // existsLocally check just passed, which is what set it.
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
        // Every recoverable case (rate limit, unreadable local file, generic failure) is already
        // handled inside onUpload's own catch above and reports its mutation via the return value,
        // so `didMutate` stays accurate. Fatal (abort) errors are rethrown there and never reach
        // here. This only exists because the shared lifecycle's contract requires the callback.
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
            files.clearWebdavDownloadBackoff(attachment.id);
            const mutated = markAttachmentUnrecoverable(attachment);
            files.logAttachmentInfo('Cleared missing WebDAV cloud key after 404', { id: attachment.id });
            return mutated;
          }
          throw error;
        }
        // Decrypt BEFORE hashing and before writing: `fileHash` is plaintext-domain (it
        // lives in the synced document and must stay stable across re-encryptions), and
        // local attachment files are always stored plaintext.
        const bytes = await common.openAttachmentBytesFromDownload(
          fileData instanceof ArrayBuffer ? new Uint8Array(fileData) : new Uint8Array(fileData as ArrayBuffer),
          material,
          cloudKey,
        );
        await validateAttachmentHash(attachment, bytes);
        const filename = cloudKey.split('/').pop() || `${attachment.id}${extractExtension(attachment.title)}`;
        const targetUri = resolveAttachmentDownloadTargetPath(
          attachment,
          `${attachmentsDir}${filename}`,
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
        files.clearWebdavDownloadBackoff(attachment.id);
        reportProgress(attachment.id, 'download', bytes.length, bytes.length, 'completed');
        return statusChanged;
      },
      onDownloadError: (attachment, error) => {
        // Rate-limit and 404 are handled inside onDownload's own try/catch above, since only
        // onDownload's return value can signal a mutation back to the lifecycle. Only "other"
        // (retry-exhausted / hash-validation / write) errors reach here.
        files.setWebdavDownloadBackoff(attachment.id, error);
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
          // Diagnostics must not replace the original fatal transport refusal.
        }
        throw error;
      }
      if (maxWebdavBufferedUploadBytes !== undefined && isAttachmentUploadAdmissionError(error)) {
        try {
          files.logAttachmentWarn('WebDAV host upload admission refused', undefined, {
            releaseCheck: 'v1.3.5/webdav-host-upload-limit', operation: 'upload', outcome: 'refused',
          });
        } catch {
          // Diagnostics must not replace the fatal admission refusal.
        }
        throw new WebdavHostUploadLimitError();
      }
      throw error;
    }
  };

  const syncCloudAttachments = async (
    appData: AppData,
    cloudConfig: MobileCloudSyncConfig,
    baseSyncUrl: string,
    options: CloudAttachmentSyncOptions = {}
  ): Promise<AppData | false> => {
    const attachmentsDir = await files.getAttachmentsDir();

    const attachmentsById = collectAttachmentsById(appData);
    // This backend runs its own loop rather than the shared lifecycle, so it does the same
    // bookkeeping by hand: write to a per-attachment working copy, record it here, and put it
    // back into `attachmentsById`. The patches are folded into a fresh document at the end.
    const allPatches = await common.migrateAttachmentsLocallyBeforeSync(attachmentsById, options.signal);
    const recordPatch = (attachment: Attachment): void => {
      allPatches.set(attachment.id, attachment);
      attachmentsById.set(attachment.id, attachment);
    };

    const pendingUploadMutations: PendingUploadMutation[] = [];
    const cloudRequestOptions = getMobileCloudRequestOptions(cloudConfig.allowInsecureHttp);

    // #1119 follow-up: prove the server still holds every blob this device has a cloudKey for,
    // at most once a day, before the loop below decides what to upload. This backend has no
    // folder listing to lean on (the self-hosted server exposes none), so it is one bounded
    // probe per attachment — see `cloudAttachmentExists` for why that probe is a capped GET
    // and not a HEAD. Anything cleared here falls into the ordinary upload branch in the same
    // pass. (Mirrors desktop's pre-pass in apps/desktop/src/lib/sync-attachment-backends.ts.)
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
          // React Native's transport buffers the whole reply before resolving, so the GET
          // fallback would download every attachment instead of probing it. Without a HEAD
          // route on the server this phone simply cannot tell, and tells nobody otherwise.
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
      // This provider cannot bind its recovery GET and replacement PUT to one
      // remote generation. Preserve the pending identity until local bytes return
      // (or a later merge supersedes it) instead of risking a stale overwrite.
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
        if (await common.prepareBespokeAttachmentContentCandidate(attachment, uri)) {
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
        const contentCheck = await common.checkBespokeAttachmentRemoteWinner(attachment, uri);
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
          const filename = attachment.cloudKey.split('/').pop()
            || `${attachment.id}${extractExtension(attachment.title)}`;
          const targetUri = `${attachmentsDir}${filename}`;
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

      // Self-hosted Cloud deliberately keeps missing remote attachments on-demand.
      // A stale file that is already present is different: merged metadata selected
      // the remote generation, so converge it through the same native present-CAS
      // installer used by the shared lifecycle rather than uploading stale bytes.
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

      // SEC-07: same containment the shared lifecycle applies via `canUploadFrom`.
      if (
        options.phase !== 'prepare'
        && (!attachment.cloudKey || attachment.pendingContentUpload === true)
        && mayUploadLocalFile
      ) {
        if (!files.shouldAttemptAttachmentUpload(attachment)) continue;
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
          snapshot = await common.createMobileAttachmentUploadSnapshot(uri, attachment);
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
          // Always the buffered PUT (bounded by the attachment size cap), never the native
          // streamed uploader: that one follows a redirect by itself (a 303 to /health answers
          // the same {"ok":true}), and servers before 1.2.7 have no HEAD to prove where the file
          // landed. Core refuses a redirected buffered PUT.
          assertCloudNotAborted(options.signal);
          const readResult = await files.readAttachmentBytesForUpload(snapshot.sourcePath);
          if (readResult.readFailed) throw readResult.error;
          const buffer = toAttachmentArrayBuffer(readResult.data);
          try {
            await options.assertRemoteMutationFenceHeld?.(CLOUD_REMOTE_MUTATION_REQUEST_HORIZON_MS);
          } catch (error) {
            shouldPropagateError = true;
            throw error;
          }
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
          if (shouldPropagateError || isAbortLikeError(error, options.signal)) {
            // The deterministic target may have existed before this attempt. Leaving
            // an unreferenced successful PUT for orphan cleanup is safe; deleting it
            // here could erase another device's winning blob.
            throw error;
          }
          const status = Number((error as { status?: unknown } | null)?.status);
          // Only what the server said about THESE BYTES may be treated as final: a body over
          // its limit (413), or content it refuses by name (400 `Blocked …`). Every other 400
          // is about the server, not the file — `Invalid attachment path` answers a storage
          // folder that became a symbolic link or moved, and it hits every upload at once — so
          // it stays an ordinary retryable failure. Core's cloudPutFile carries the body as
          // `refusalText`.
          // Bounded like desktop's client-side refusals: a first upload becomes terminal;
          // a replacement stays pending but this content identity is no longer retried.
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

    // Same rule as WebDAV: only a pass whose presence proof ran to the end may advance the
    // stamp, so a probe the server could not answer retries next cycle instead of parking the
    // repair for a day. Never stamped for an activation probe, whose subject is the candidate
    // configuration rather than the committed one the stamp names.
    if (reconcilePresence && presenceProven && !options.activationProbe) {
      await files.markAttachmentPresenceReconciled();
    }

    const nextData = applyAttachmentPatches(appData, allPatches);
    return nextData !== appData ? nextData : false;
  };

  const syncDropboxAttachments = async (
    appData: AppData,
    dropboxClientId: string,
    fetcher: typeof fetch,
    options: DropboxAttachmentSyncOptions = {}
  ): Promise<AppData | false> => {
    if (!dropboxClientId) return false;
    const attachmentsDir = await files.getAttachmentsDir();
    const attachmentsById = collectAttachmentsById(appData);
    // This backend runs its own loops rather than the shared lifecycle, so it does the same
    // bookkeeping by hand: write to a per-attachment working copy, record it here, and put it
    // back into `attachmentsById`. The patches are folded into a fresh document at the end.
    const allPatches = await common.migrateAttachmentsLocallyBeforeSync(attachmentsById, options.signal);
    const recordPatch = (attachment: Attachment): void => {
      allPatches.set(attachment.id, attachment);
      attachmentsById.set(attachment.id, attachment);
    };
    const foldPatches = (): AppData | false => {
      const nextData = applyAttachmentPatches(appData, allPatches);
      return nextData !== appData ? nextData : false;
    };

    // #1119 follow-up: prove Dropbox still holds every blob this device has a cloudKey for,
    // at most once a day, before the loop below decides what to upload. One `list_folder`
    // answers the whole pass however many attachments there are; a listing that fails proves
    // nothing and clears nothing. Anything cleared here falls into the ordinary upload branch
    // in the same pass, so the repair completes without waiting for another cycle.
    // (Mirrors desktop's pre-pass in apps/desktop/src/lib/sync-attachment-backends.ts.)
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
        if (await common.prepareBespokeAttachmentContentCandidate(attachment, uri)) {
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
        const contentCheck = await common.checkBespokeAttachmentRemoteWinner(attachment, uri);
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

      // SEC-07: same containment the shared lifecycle applies via `canUploadFrom`.
      if (
        options.phase !== 'prepare'
        && (!attachment.cloudKey || attachment.pendingContentUpload === true)
        && mayUploadLocalFile
      ) {
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
        let snapshot: Awaited<ReturnType<typeof common.createMobileAttachmentUploadSnapshot>> = null;
        try {
          assertDropboxNotAborted(options.signal);
          snapshot = await common.createMobileAttachmentUploadSnapshot(uri, attachment);
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
          const wireBytes = await common.sealAttachmentBytesForUpload(uploadBytes, options.material, cloudKey);
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
          if (isAbortLikeError(error, options.signal)) {
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
      if (!options.activationProbe && downloadCount >= DROPBOX_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC) {
        files.logAttachmentInfo('Dropbox attachment download limit reached', {
          limit: String(DROPBOX_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC),
        });
        break;
      }
      downloadCount += 1;

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
        // Decrypt before hashing/writing: `fileHash` is plaintext-domain and the local
        // attachments directory always holds plaintext.
        const bytes = await common.openAttachmentBytesFromDownload(
          data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer),
          options.material,
          cloudKey,
        );
        await validateAttachmentHash(attachment, bytes);
        const filename = cloudKey.split('/').pop() || `${attachment.id}${extractExtension(attachment.title)}`;
        const targetUri = resolveAttachmentDownloadTargetPath(
          attachment,
          `${attachmentsDir}${filename}`,
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
        await common.refreshBespokeAttachmentDownloadedContentStat(attachment, targetUri);
        recordPatch(attachment);
        reportProgress(attachment.id, 'download', bytes.length, bytes.length, 'completed');
      } catch (error) {
        if (isAbortLikeError(error, options.signal)) {
          throw error;
        }
        if (
          expectation.kind === 'absent'
          && !recoverPendingUpload
          && core.isDropboxFileNotFoundError(error)
          && attachment.cloudKey
        ) {
          if (markAttachmentUnrecoverable(attachment)) {
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

    // Same rule as WebDAV: only a pass whose presence proof ran to the end may advance the
    // stamp, so a listing the server could not answer retries next cycle instead of parking
    // the repair for a day. Never stamped for an activation probe, whose subject is the
    // candidate configuration rather than the committed one the stamp names.
    if (reconcilePresence && presenceProven && !options.activationProbe) {
      await files.markAttachmentPresenceReconciled();
    }

    return foldPatches();
  };

  const syncFileAttachments = async (
    appData: AppData,
    syncPath: string,
    signal?: AbortSignal,
    options: {
      activationProbe?: boolean;
      phase?: 'prepare' | 'post-merge';
      /** #1056: seal bytes before they land in the sync folder. Null = encryption off. */
      material?: SyncKeyMaterial | null;
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
    const syncDir = await files.resolveFileSyncDir(syncPath);
    if (!syncDir) return false;

    // The folder lease is already held by the sync cycle. Recover only exact
    // scratch paths durably reserved by this device; never infer ownership by
    // scanning the shared attachments directory.
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

    // Memoized across the whole pass: every attachment that needs a SAF lookup this round shares
    // one directory listing rather than re-reading it per attachment.
    let safEntriesByName: Map<string, string> | null = null;
    const refreshSafEntriesByName = async (): Promise<Map<string, string>> => {
      const inventory = await files.inspectSafDirectoryEntriesByName(syncDir.attachmentsDirUri);
      if (inventory.status === 'unreadable') {
        throw new Error('SAF attachment inventory is unreadable');
      }
      safEntriesByName = inventory.entries;
      return inventory.entries;
    };
    const getSafEntriesByName = async (): Promise<Map<string, string>> => (
      safEntriesByName ?? refreshSafEntriesByName()
    );
    const remoteFilenameFor = (cloudKey: string, attachment: { id: string; title: string }): string =>
      cloudKey.split('/').pop() || `${attachment.id}${extractExtension(attachment.title)}`;

    // File-backend-specific pre-pass, interleaving two things per attachment (matching this
    // backend's pre-lifecycle shape exactly): the shared local-migration step, then a
    // reconciliation check unique to this backend — unlike the other backends, an already
    // cloudKey'd attachment isn't assumed to still be on the remote, since this backend syncs to a
    // plain folder a user could have edited directly. So every local, existing attachment gets its
    // remote presence checked here regardless of cloudKey state; if missing, clearing cloudKey
    // lets the lifecycle below re-upload it through its normal hasCloudCopy-false path.
    // The remote-presence half of the pre-pass below is periodic, not per-cycle: it can only
    // discover a file removed from the sync folder behind the app's back, and paying two native
    // stats per attachment on every idle cycle to re-learn that nothing moved is the local
    // half of audit F3. The local-migration half is NOT gated — an unmigrated attachment is
    // real pending work that `hasPendingAttachmentSyncWork` reports on every cycle.
    // An activation probe must prove the candidate folder holds every object right now, so it
    // always reconciles and never stamps (the stamp names the committed configuration).
    const reconcilePresence = options.activationProbe || await files.isAttachmentPresenceReconciliationDue();
    const migrateAttachmentLocally = files.createAttachmentLocalMigrationLimiter();
    // Both steps write only to a per-attachment working copy, recorded here and put back into
    // `attachmentsById` so the lifecycle below reads the pre-pass's values.
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
      getLocalFileStat: (path) => files.statAttachmentFile(path),
      computeLocalFileHash: (path) => computeManagedAttachmentFileHash(path),
      maxBufferedUploadBytes: core.maxFileSyncBufferedPlaintextBytes(),
      contentChangePhase: options.phase,
      isFatalError: (error) => (
        isAttachmentSyncAbortError(error, signal)
        || isAttachmentUploadAdmissionError(error)
      ),
      // Normal background sync leaves remote-only files for on-demand fetch. An
      // activation probe is different: its cloned snapshot must prove that every
      // referenced object exists before settings commit. Marking the clone
      // available is only the proof signal consumed by the shared probe; neither
      // localStatus nor this clone is persisted.
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
          (attachment.pendingContentUpload === true || expectation.kind === 'present')
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
          // A blob the folder does not hold yet is not a verdict on File Sync: a
          // replicator (Syncthing, a mounted drive) can deliver it after the
          // switch. Keep the key and leave the record missing so core's
          // activation proof defers it (its `backend === 'file'` accept path
          // needs the key to still be there), exactly as the desktop backend
          // does. Clearing the key here turned that path into a refusal on
          // every phone while the same folder activated on the desktop
          // (2026-09-06 feedback).
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
            // Manual removal of the corrupt canonical generation is an explicit
            // recovery action; do not keep its bounded collision history latched.
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
          // No catch from here on: the durable exact-path reservation owns the verified
          // stage. The next locked cycle removes it before retry; corrupt canonical
          // collisions also retain a bounded device-local attempt count.
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
            if (getSafLeafName(targetUri) !== filename) {
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
        // localStatus is already 'available' here: onUpload only runs when the lifecycle's own
        // existsLocally check just passed, which is what set it.
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
