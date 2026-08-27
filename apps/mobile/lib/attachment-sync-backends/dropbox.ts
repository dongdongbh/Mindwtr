import {
  applyAttachmentPatches,
  applyAttachmentContentStat,
  isAbortError,
  isSha256Hex,
  isSyncRemoteMutationFenceError,
  validateAttachmentForUpload,
  type AppData,
  type Attachment,
  type LocalFileStat,
  type SyncKeyMaterial,
} from '@mindwtr/core';
import {
  DropboxConflictError,
  DropboxFileNotFoundError,
  downloadDropboxFile,
  getDropboxFileMetadata,
  uploadDropboxFileVersioned,
} from '../dropbox-sync';
import {
  buildCloudKey,
  collectAttachments,
  canUploadAttachmentFrom,
  DROPBOX_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC,
  DROPBOX_ATTACHMENT_MAX_UPLOADS_PER_SYNC,
  extractExtension,
  getAttachmentLocalStatus,
  getAttachmentsDir,
  getLocalAttachmentPresence,
  isContentAttachmentUri,
  isHttpAttachmentUri,
  logAttachmentInfo,
  logAttachmentWarn,
  markAttachmentUnrecoverable,
  readAttachmentBytesForUpload,
  reportProgress,
  runDropboxAuthorized,
  toArrayBuffer,
  type DropboxAccessTokenResolver,
  validateAttachmentHash,
  writeBytesSafely,
} from '../attachment-sync-utils';
import {
  migrateAttachmentsLocallyBeforeSync,
  createMobileAttachmentUploadSnapshot,
  openAttachmentBytesFromDownload,
  prepareBespokeAttachmentContentCandidate,
  sealAttachmentBytesForUpload,
} from './common';

export type DropboxAttachmentSyncOptions = {
  activationProbe?: boolean;
  phase?: 'prepare' | 'post-merge';
  resolveAccessToken?: DropboxAccessTokenResolver;
  signal?: AbortSignal;
  assertRemoteMutationFenceHeld?: (minRemainingMs?: number) => Promise<void>;
  /** #1056: seal bytes before upload / open them after download. Null = encryption off. */
  material?: SyncKeyMaterial | null;
};

type PendingDropboxUploadMutation = {
  attachment: Attachment;
  cloudKey: string;
  fileHash: string;
  stat: LocalFileStat;
  fileSize?: number;
  totalBytes: number;
};

type DropboxDownloadCandidate = {
  attachment: Attachment;
  recoverPendingUpload: boolean;
};

const createAbortError = (): Error => {
  const error = new Error('Dropbox attachment sync aborted');
  error.name = 'AbortError';
  return error;
};

const assertNotAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  throw createAbortError();
};

const isAbortLikeError = (error: unknown, signal?: AbortSignal): boolean => (
  Boolean(signal?.aborted) || isAbortError(error)
);

export const syncDropboxAttachments = async (
  appData: AppData,
  dropboxClientId: string,
  fetcher: typeof fetch = fetch,
  options: DropboxAttachmentSyncOptions = {}
): Promise<AppData | false> => {
  if (!dropboxClientId) return false;
  const attachmentsDir = await getAttachmentsDir();
  const attachmentsById = collectAttachments(appData);
  // This backend runs its own loops rather than the shared lifecycle, so it does the same
  // bookkeeping by hand: write to a per-attachment working copy, record it here, and put it
  // back into `attachmentsById`. The patches are folded into a fresh document at the end.
  const allPatches = await migrateAttachmentsLocallyBeforeSync(attachmentsById, options.signal);
  const recordPatch = (attachment: Attachment): void => {
    allPatches.set(attachment.id, attachment);
    attachmentsById.set(attachment.id, attachment);
  };
  const foldPatches = (): AppData | false => {
    const nextData = applyAttachmentPatches(appData, allPatches);
    return nextData !== appData ? nextData : false;
  };

  const downloadQueue: DropboxDownloadCandidate[] = [];
  const pendingUploadMutations: PendingDropboxUploadMutation[] = [];
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
      ? await getLocalAttachmentPresence(uri)
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
      && canUploadAttachmentFrom(uri);
    if (options.phase === 'prepare' && attachment.cloudKey && mayUploadLocalFile) {
      if (await prepareBespokeAttachmentContentCandidate(attachment, uri)) {
        recordPatch(attachment);
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
          logAttachmentInfo('Dropbox attachment upload limit reached', {
            limit: String(DROPBOX_ATTACHMENT_MAX_UPLOADS_PER_SYNC),
          });
        }
        continue;
      }
      uploadCount += 1;
      let snapshot: Awaited<ReturnType<typeof createMobileAttachmentUploadSnapshot>> = null;
      try {
        assertNotAborted(options.signal);
        snapshot = await createMobileAttachmentUploadSnapshot(uri, attachment);
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
          logAttachmentWarn(`Attachment validation failed (${validation.error}) for ${attachment.id}`);
          continue;
        }
        const totalBytes = Math.max(0, Number(fileSize ?? 0));
        reportProgress(attachment.id, 'upload', 0, totalBytes, 'active');

        const cloudKey = buildCloudKey(attachment);
        const readResult = await readAttachmentBytesForUpload(snapshot.sourcePath);
        if (readResult.readFailed) throw readResult.error;
        const uploadBytes = readResult.data;
        const wireBytes = await sealAttachmentBytesForUpload(uploadBytes, options.material);
        const expectedRev = await runDropboxAuthorized(
          dropboxClientId,
          (accessToken) => getDropboxFileMetadata(
            accessToken,
            cloudKey,
            fetcher,
            { signal: options.signal },
          ),
          fetcher,
          options.resolveAccessToken,
        ).then((metadata) => metadata.rev);
        await runDropboxAuthorized(
          dropboxClientId,
          async (accessToken) => {
            await options.assertRemoteMutationFenceHeld?.(35_000);
            return uploadDropboxFileVersioned(
              accessToken,
              cloudKey,
              toArrayBuffer(wireBytes),
              expectedRev,
              fetcher,
              { signal: options.signal },
            );
          },
          fetcher,
          options.resolveAccessToken,
        );

        assertNotAborted(options.signal);
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
        if (isSyncRemoteMutationFenceError(error) || error instanceof DropboxConflictError) {
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
        logAttachmentWarn(`Failed to upload attachment ${attachment.id}`, error);
      } finally {
        if (snapshot) {
          await snapshot.dispose().catch((error) => {
            logAttachmentWarn(`Failed to clean up attachment upload snapshot ${attachment.id}`, error);
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
        downloadQueue.push({ attachment, recoverPendingUpload: false });
      } else if (isSha256Hex(attachment.fileHash?.trim().toLowerCase())) {
        downloadQueue.push({ attachment, recoverPendingUpload: true });
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
  for (const { attachment, recoverPendingUpload } of downloadQueue) {
    if (attachment.kind !== 'file') continue;
    if (attachment.deletedAt) continue;
    if (!attachment.cloudKey) continue;
    if (!options.activationProbe && downloadCount >= DROPBOX_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC) {
      logAttachmentInfo('Dropbox attachment download limit reached', {
        limit: String(DROPBOX_ATTACHMENT_MAX_DOWNLOADS_PER_SYNC),
      });
      break;
    }
    downloadCount += 1;

    const cloudKey = attachment.cloudKey;
    try {
      assertNotAborted(options.signal);
      reportProgress(attachment.id, 'download', 0, attachment.size ?? 0, 'active');
      const data = await runDropboxAuthorized(
        dropboxClientId,
        (accessToken) => downloadDropboxFile(
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
      const bytes = await openAttachmentBytesFromDownload(
        data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer),
        options.material,
      );
      await validateAttachmentHash(attachment, bytes);
      const filename = cloudKey.split('/').pop() || `${attachment.id}${extractExtension(attachment.title)}`;
      const targetUri = `${attachmentsDir}${filename}`;
      assertNotAborted(options.signal);
      await writeBytesSafely(targetUri, bytes);
      let mutated = attachment.uri !== targetUri || attachment.localStatus !== 'available';
      if (recoverPendingUpload && attachment.pendingContentUpload === true) {
        attachment.pendingContentUpload = undefined;
        mutated = true;
      }
      if (mutated) {
        attachment.uri = targetUri;
        attachment.localStatus = 'available';
        recordPatch(attachment);
      }
      reportProgress(attachment.id, 'download', bytes.length, bytes.length, 'completed');
    } catch (error) {
      if (isAbortLikeError(error, options.signal)) {
        throw error;
      }
      if (!recoverPendingUpload && error instanceof DropboxFileNotFoundError && attachment.cloudKey) {
        if (markAttachmentUnrecoverable(attachment)) {
          recordPatch(attachment);
        }
      }
      if (!(error instanceof DropboxFileNotFoundError) && attachment.localStatus !== 'missing') {
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
      logAttachmentWarn(`Failed to download attachment ${attachment.id}`, error);
    }
  }

  return foldPatches();
};
