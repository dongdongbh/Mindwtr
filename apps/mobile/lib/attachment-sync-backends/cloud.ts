import type { AppData } from '@mindwtr/core';
import {
  applyAttachmentPatches,
  cloudDeleteFile,
  cloudGetFile,
  cloudPutFile,
  isAbortError,
  validateAttachmentForUpload,
  type Attachment,
} from '@mindwtr/core';
import { logAttachmentWarn } from '../attachment-sync-utils';
import {
  buildCloudKey,
  canUploadAttachmentFrom,
  collectAttachments,
  DEFAULT_CONTENT_TYPE,
  extractExtension,
  fileExists,
  getAttachmentByteSize,
  getAttachmentLocalStatus,
  getAttachmentsDir,
  isHttpAttachmentUri,
  markAttachmentUnrecoverable,
  readAttachmentBytesForUpload,
  reportProgress,
  toArrayBuffer,
  validateAttachmentHash,
  writeBytesSafely,
  type CloudConfig,
} from '../attachment-sync-utils';
import { migrateAttachmentsLocallyBeforeSync, uploadCloudFileWithFileSystem } from './common';

export type CloudAttachmentSyncOptions = {
  activationProbe?: boolean;
  assertCurrent?: () => void;
  signal?: AbortSignal;
};

type PendingCloudUploadMutation = {
  attachment: Attachment;
  cloudKey: string;
  fileSize?: number;
  totalBytes: number;
  uploadUrl: string;
};

const createAbortError = (): Error => {
  const error = new Error('Attachment upload aborted');
  error.name = 'AbortError';
  return error;
};

const assertNotAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  throw createAbortError();
};

const isAbortLikeError = (error: unknown, signal?: AbortSignal): boolean => {
  return Boolean(signal?.aborted) || isAbortError(error);
};

export const syncCloudAttachments = async (
  appData: AppData,
  cloudConfig: CloudConfig,
  baseSyncUrl: string,
  options: CloudAttachmentSyncOptions = {}
): Promise<AppData | false> => {
  const attachmentsDir = await getAttachmentsDir();

  const attachmentsById = collectAttachments(appData);
  // This backend runs its own loop rather than the shared lifecycle, so it does the same
  // bookkeeping by hand: write to a per-attachment working copy, record it here, and put it
  // back into `attachmentsById`. The patches are folded into a fresh document at the end.
  const allPatches = await migrateAttachmentsLocallyBeforeSync(attachmentsById, options.signal);
  const recordPatch = (attachment: Attachment): void => {
    allPatches.set(attachment.id, attachment);
    attachmentsById.set(attachment.id, attachment);
  };

  const pendingUploadMutations: PendingCloudUploadMutation[] = [];

  const cleanupUploadedCloudFile = async (uploadUrl: string, attachmentId: string) => {
    try {
      await cloudDeleteFile(uploadUrl, { token: cloudConfig.token });
    } catch (deleteError) {
      logAttachmentWarn(`Failed to clean up aborted attachment upload ${attachmentId}`, deleteError);
    }
  };

  const cleanupPendingUploadMutations = async () => {
    for (const pending of pendingUploadMutations) {
      await cleanupUploadedCloudFile(pending.uploadUrl, pending.attachment.id);
    }
    pendingUploadMutations.length = 0;
  };

  for (const original of attachmentsById.values()) {
    if (original.kind !== 'file') continue;
    if (original.deletedAt) continue;

    const attachment: Attachment = { ...original };

    const uri = attachment.uri || '';
    const isHttp = isHttpAttachmentUri(uri);
    const hasLocalPath = Boolean(uri) && !isHttp;
    const existsLocally = hasLocalPath ? await fileExists(uri) : false;
    const nextStatus = getAttachmentLocalStatus(uri, existsLocally);
    if (attachment.localStatus !== nextStatus) {
      attachment.localStatus = nextStatus;
      recordPatch(attachment);
    }

    if (options.activationProbe && existsLocally && attachment.cloudKey) {
      attachment.cloudKey = undefined;
      recordPatch(attachment);
    }

    // Activation proof for a JOINING device: an attachment uploaded by another
    // device has a cloudKey but no local file here — this backend normally
    // fetches attachments on demand, so without a download leg the probe's
    // "every attachment proven available" assert could never pass and the
    // configuration could never activate (the desktop cloud backend and the
    // mobile WebDAV/Dropbox backends download through the shared lifecycle;
    // this hand-rolled loop had upload only). Steady-state cycles keep the
    // on-demand behavior — this runs during the activation probe alone.
    if (options.activationProbe && attachment.cloudKey && !existsLocally && attachmentsDir) {
      try {
        assertNotAborted(options.signal);
        const cloudKey = attachment.cloudKey;
        reportProgress(attachment.id, 'download', 0, attachment.size ?? 0, 'active');
        const fileData = await cloudGetFile(`${baseSyncUrl}/${cloudKey}`, {
          token: cloudConfig.token,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        const bytes = new Uint8Array(fileData);
        await validateAttachmentHash(attachment, bytes);
        const filename = cloudKey.split('/').pop() || `${attachment.id}${extractExtension(attachment.title)}`;
        const targetUri = `${attachmentsDir}${filename}`;
        await writeBytesSafely(targetUri, bytes);
        attachment.uri = targetUri;
        attachment.localStatus = 'available';
        recordPatch(attachment);
        reportProgress(attachment.id, 'download', bytes.length, bytes.length, 'completed');
        continue;
      } catch (error) {
        if (isAbortLikeError(error, options.signal)) {
          await cleanupPendingUploadMutations();
          throw error;
        }
        reportProgress(
          attachment.id,
          'download',
          0,
          attachment.size ?? 0,
          'failed',
          error instanceof Error ? error.message : String(error)
        );
        logAttachmentWarn(`Failed to download attachment ${attachment.id} during activation`, error);
      }
    }

    // SEC-07: same containment the shared lifecycle applies via `canUploadFrom`.
    if (!attachment.cloudKey && hasLocalPath && existsLocally && !isHttp && canUploadAttachmentFrom(uri)) {
      let localReadFailed = false;
      let shouldPropagateError = false;
      let uploadUrlForCleanup: string | null = null;
      try {
        assertNotAborted(options.signal);
        try {
          options.assertCurrent?.();
        } catch (error) {
          shouldPropagateError = true;
          throw error;
        }
        let fileSize = await getAttachmentByteSize(attachment, uri);
        let fileData: Uint8Array | null = null;
        if (!Number.isFinite(fileSize ?? NaN)) {
          const readResult = await readAttachmentBytesForUpload(uri);
          if (readResult.readFailed) {
            localReadFailed = true;
            throw readResult.error;
          }
          fileData = readResult.data;
          fileSize = fileData.byteLength;
        }

        const validation = await validateAttachmentForUpload(attachment, fileSize);
        if (!validation.valid) {
          logAttachmentWarn(`Attachment validation failed (${validation.error}) for ${attachment.id}`);
          continue;
        }
        const totalBytes = Math.max(0, Number(fileSize ?? 0));
        reportProgress(attachment.id, 'upload', 0, totalBytes, 'active');
        const cloudKey = buildCloudKey(attachment);
        const uploadUrl = `${baseSyncUrl}/${cloudKey}`;
        uploadUrlForCleanup = uploadUrl;
        const uploadedWithFileSystem = await uploadCloudFileWithFileSystem(
          uploadUrl,
          uri,
          attachment.mimeType || DEFAULT_CONTENT_TYPE,
          cloudConfig.token,
          (loaded, total) => reportProgress(attachment.id, 'upload', loaded, total, 'active'),
          totalBytes,
          options.signal
        );
        if (!uploadedWithFileSystem) {
          assertNotAborted(options.signal);
          let uploadBytes = fileData;
          if (!uploadBytes) {
            const readResult = await readAttachmentBytesForUpload(uri);
            if (readResult.readFailed) {
              localReadFailed = true;
              throw readResult.error;
            }
            uploadBytes = readResult.data;
          }
          const buffer = toArrayBuffer(uploadBytes);
          await cloudPutFile(
            uploadUrl,
            buffer,
            attachment.mimeType || DEFAULT_CONTENT_TYPE,
            options.signal
              ? { token: cloudConfig.token, signal: options.signal }
              : { token: cloudConfig.token }
          );
        }
        try {
          options.assertCurrent?.();
        } catch (error) {
          shouldPropagateError = true;
          throw error;
        }
        pendingUploadMutations.push({
          attachment,
          cloudKey,
          fileSize: Number.isFinite(fileSize ?? NaN) ? Number(fileSize) : undefined,
          totalBytes,
          uploadUrl,
        });
        uploadUrlForCleanup = null;
      } catch (error) {
        if (shouldPropagateError || isAbortLikeError(error, options.signal)) {
          if (uploadUrlForCleanup) {
            await cleanupUploadedCloudFile(uploadUrlForCleanup, attachment.id);
          }
          await cleanupPendingUploadMutations();
          throw error;
        }
        if (uploadUrlForCleanup && !localReadFailed) {
          await cleanupUploadedCloudFile(uploadUrlForCleanup, attachment.id);
        }
        if (localReadFailed) {
          if (markAttachmentUnrecoverable(attachment)) {
            recordPatch(attachment);
          }
          logAttachmentWarn(`Attachment local file is unreadable; marking unrecoverable (${attachment.id})`, error);
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
      }
    }
  }

  for (const pending of pendingUploadMutations) {
    pending.attachment.cloudKey = pending.cloudKey;
    if (!Number.isFinite(pending.attachment.size ?? NaN) && Number.isFinite(pending.fileSize ?? NaN)) {
      pending.attachment.size = Number(pending.fileSize);
    }
    pending.attachment.localStatus = 'available';
    recordPatch(pending.attachment);
    reportProgress(pending.attachment.id, 'upload', pending.totalBytes, pending.totalBytes, 'completed');
  }

  const nextData = applyAttachmentPatches(appData, allPatches);
  return nextData !== appData ? nextData : false;
};
