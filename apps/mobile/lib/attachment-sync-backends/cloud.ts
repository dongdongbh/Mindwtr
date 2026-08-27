import type { AppData } from '@mindwtr/core';
import {
  applyAttachmentPatches,
  cloudGetFile,
  cloudPutFile,
  isAbortError,
  validateAttachmentHash,
  validateAttachmentForUpload,
  type Attachment,
} from '@mindwtr/core';
import { logAttachmentWarn } from '../attachment-sync-utils';
import { getMobileCloudRequestOptions } from '../webdav-request-options';
import {
  buildCloudKey,
  canUploadAttachmentFrom,
  collectAttachments,
  DEFAULT_CONTENT_TYPE,
  fileExists,
  getAttachmentByteSize,
  getAttachmentLocalStatus,
  getAttachmentsDir,
  isHttpAttachmentUri,
  markAttachmentUnrecoverable,
  readAttachmentBytesForUpload,
  reportProgress,
  toArrayBuffer,
  type CloudConfig,
} from '../attachment-sync-utils';
import {
  migrateAttachmentsLocallyBeforeSync,
  pendingBespokeAttachmentContentStillMatches,
  prepareBespokeAttachmentContentCandidate,
  uploadCloudFileWithFileSystem,
} from './common';

export type CloudAttachmentSyncOptions = {
  activationProbe?: boolean;
  assertCurrent?: () => void;
  assertRemoteMutationFenceHeld?: (minRemainingMs?: number) => Promise<void>;
  phase?: 'prepare' | 'post-merge';
  signal?: AbortSignal;
};

const CLOUD_REMOTE_MUTATION_REQUEST_HORIZON_MS = 35_000;

type PendingCloudUploadMutation = {
  attachment: Attachment;
  cloudKey: string;
  fileSize?: number;
  totalBytes: number;
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
  await getAttachmentsDir();

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
  const cloudRequestOptions = getMobileCloudRequestOptions(cloudConfig.allowInsecureHttp);

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

    const mayUploadLocalFile = hasLocalPath
      && existsLocally
      && !isHttp
      && canUploadAttachmentFrom(uri);
    if (options.phase === 'prepare' && attachment.cloudKey && mayUploadLocalFile) {
      if (await prepareBespokeAttachmentContentCandidate(attachment, uri)) {
        recordPatch(attachment);
      }
    }

    if (
      options.activationProbe
      && options.phase !== 'prepare'
      && attachment.cloudKey
      && !existsLocally
      && !isHttp
    ) {
      try {
        assertNotAborted(options.signal);
        const data = await cloudGetFile(
          `${baseSyncUrl}/${attachment.cloudKey}`,
          options.signal
            ? { ...cloudRequestOptions, token: cloudConfig.token, signal: options.signal }
            : { ...cloudRequestOptions, token: cloudConfig.token },
        );
        await validateAttachmentHash(attachment, new Uint8Array(data));
        attachment.localStatus = 'available';
        recordPatch(attachment);
      } catch (error) {
        if (isAbortLikeError(error, options.signal)) throw error;
        logAttachmentWarn(`Failed to prove candidate attachment ${attachment.id}`, error);
      }
      continue;
    }

    // SEC-07: same containment the shared lifecycle applies via `canUploadFrom`.
    if (
      options.phase !== 'prepare'
      && (!attachment.cloudKey || attachment.pendingContentUpload === true)
      && mayUploadLocalFile
    ) {
      if (
        attachment.pendingContentUpload === true
        && !(await pendingBespokeAttachmentContentStillMatches(attachment, uri))
      ) {
        continue;
      }
      let localReadFailed = false;
      let shouldPropagateError = false;
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
        try {
          await options.assertRemoteMutationFenceHeld?.(CLOUD_REMOTE_MUTATION_REQUEST_HORIZON_MS);
        } catch (error) {
          shouldPropagateError = true;
          throw error;
        }
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
          try {
            await options.assertRemoteMutationFenceHeld?.(CLOUD_REMOTE_MUTATION_REQUEST_HORIZON_MS);
          } catch (error) {
            shouldPropagateError = true;
            throw error;
          }
          await cloudPutFile(
            uploadUrl,
            buffer,
            attachment.mimeType || DEFAULT_CONTENT_TYPE,
            options.signal
              ? { ...cloudRequestOptions, token: cloudConfig.token, signal: options.signal }
              : { ...cloudRequestOptions, token: cloudConfig.token }
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
        });
      } catch (error) {
        if (shouldPropagateError || isAbortLikeError(error, options.signal)) {
          // The deterministic target may have existed before this attempt. Leaving
          // an unreferenced successful PUT for orphan cleanup is safe; deleting it
          // here could erase another device's winning blob.
          throw error;
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
    pending.attachment.pendingContentUpload = undefined;
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
